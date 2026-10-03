import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { prisma } from "@/server/db";
import { PUBLIC } from "@/server/rbac/actor";
import { adjustStock, receiveStock } from "@/server/services/inventory";
import { cancelOrder, checkout, counterSale, expireHolds, listCatalogue, returnItems, setOrderStatus, setTicketStatus } from "@/server/services/shop";
import { recordCounterPayment, verifyOnlinePayment } from "@/server/services/payments";
import { testGateway } from "@/server/services/gateway";
import { payExpense } from "@/server/services/expenses";
import { makeWorld, type World, utr, CARD_PROOF } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const stock = (variantId: string) => prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
const visitor = { name: "Visitor Vee", phone: "9876500001", email: "vee@example.com" };

async function payOnline(paymentId: string) {
  const gpid = testGateway.newGatewayPaymentId();
  return verifyOnlinePayment(paymentId, { gatewayPaymentId: gpid, outcome: "SUCCESS", signature: testGateway.sign(paymentId, gpid, "SUCCESS") });
}

describe("Phase 4 — counter sale (SH-4, R-19, R-24)", () => {
  it("SH-4: selling beyond available → INSUFFICIENT_STOCK and the whole sale rolls back", async () => {
    const balls = await makeProduct(w, { name: "Tennis balls (3)", category: "BALLS", price: 50000, onHand: 5 });
    const grip = await makeProduct(w, { name: "Overgrip", category: "ACCESSORIES", price: 25000, onHand: 2 });
    await expect(
      counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: balls.variantId, qty: 2 }, { variantId: grip.variantId, qty: 3 }], payments: [{ method: "CASH" }] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", message: "Only 2 of Overgrip available; 3 requested." });
    expect((await stock(balls.variantId)).onHand).toBe(5);
    expect(await prisma.counterSale.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.stockMovement.count({ where: { reason: "COUNTER_SALE" } })).toBe(0);
  });

  it("R-24/PR-5: a Silver member gets 10% off automatically; split cash + UPI must cover the total", async () => {
    const neha = await makeMember(w, { name: "Neha", plan: "SILVER" });
    const shoes = await makeProduct(w, { name: "Court shoes", category: "SHOES", price: 600000, onHand: 4 });
    await expect(
      counterSale(w.actors.SHOP_STAFF, { memberId: neha.memberId, items: [{ variantId: shoes.variantId, qty: 1 }], payments: [{ method: "CASH", amount: 100000 }] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/sale total is ₹5,400/) });
    const r = await counterSale(w.actors.SHOP_STAFF, {
      memberId: neha.memberId, items: [{ variantId: shoes.variantId, qty: 1 }],
      payments: [{ method: "CASH", amount: 200000, tendered: 200000 }, { method: "UPI", reference: utr(), amount: 340000 }],
    });
    expect(r.total).toBe(540000);
    expect(r.discountTotal).toBe(60000);
    expect(r.lines[0].explanation).toMatch(/Silver member · 10% shop discount/);
    expect(r.billStatus).toBe("PAID");
    expect((await stock(shoes.variantId)).onHand).toBe(3);
    await expectIntegrity();
  });

  it("RBAC: bar staff cannot sell at the shop counter", async () => {
    const p = await makeProduct(w, { name: "Wristband", category: "ACCESSORIES", price: 20000, onHand: 3 });
    await expect(counterSale(w.actors.BAR_STAFF, { items: [{ variantId: p.variantId, qty: 1 }], payments: [{ method: "CASH" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("SH-12/E-10: selling a restring creates a ticket; READY notifies the member", async () => {
    const m = await makeMember(w, { name: "String Snap", plan: "GOLD" });
    const restring = await makeProduct(w, { name: "Racket restring", category: "SERVICES", price: 80000, isRestring: true });
    const r = await counterSale(w.actors.SHOP_STAFF, { memberId: m.memberId, items: [{ variantId: restring.variantId, qty: 1 }], payments: [{ method: "UPI", reference: utr() }], restring: { racket: "Wilson Blade 98", notes: "24 kg" } });
    expect(r.total).toBe(68000); // Gold 15% off services too (PR-5)
    expect(r.tickets).toHaveLength(1);
    const t = await prisma.serviceTicket.findFirstOrThrow();
    await expect(setTicketStatus(w.actors.SHOP_STAFF, t.id, "READY")).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await setTicketStatus(w.actors.SHOP_STAFF, t.id, "IN_PROGRESS");
    await setTicketStatus(w.actors.SHOP_STAFF, t.id, "READY");
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "RESTRING_READY" } })).toBe(1);
  });
});

describe("Phase 4 — one shelf for counter and online (SH-5…SH-7, R-20…R-23)", () => {
  it("SH-7: an online reservation of the last unit blocks a counter sale of it", async () => {
    const rahul = await makeMember(w, { name: "Rahul", plan: "GOLD" });
    const racket = await makeProduct(w, { name: "Pro Staff 97", price: 1500000, onHand: 1, reorderLevel: 1 });
    const order = await checkout(rahul.actor, { items: [{ variantId: racket.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    expect(order.status).toBe("CONFIRMED");
    expect(order.total).toBe(1275000);
    expect((await stock(racket.variantId)).reserved).toBe(1);
    await expect(counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "CARD", ...CARD_PROOF }] })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      message: "Pro Staff 97 is out of stock (1 reserved for online orders).",
    });
    const cat = await listCatalogue();
    expect(cat.find((p) => p.name === "Pro Staff 97")!.variants[0].stockLabel).toBe("Out of stock");
  });

  it("SH-8: a low-stock alert fires once while low, and again only after a restock", async () => {
    const p = await makeProduct(w, { name: "Dampener", category: "ACCESSORIES", price: 15000, onHand: 5, reorderLevel: 3 });
    const sell = (qty: number) => counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: p.variantId, qty }], payments: [{ method: "CASH" }] });
    await sell(1);
    expect(await prisma.notification.count({ where: { type: "LOW_STOCK" } })).toBe(0);
    await sell(1); // 3 left = reorder level → low
    const first = await prisma.notification.count({ where: { type: "LOW_STOCK" } });
    expect(first).toBe(3); // shop staff, manager, owner
    await sell(1);
    expect(await prisma.notification.count({ where: { type: "LOW_STOCK" } })).toBe(first);
    await receiveStock(w.actors.SHOP_STAFF, { variantId: p.variantId, qty: 10, unitCost: 8000, supplier: "Acme" });
    expect((await stock(p.variantId)).lowStockAlerted).toBe(false);
    await sell(10);
    expect(await prisma.notification.count({ where: { type: "LOW_STOCK" } })).toBe(first * 2);
  });

  it("SH-5: an unpaid online order's hold expires after 15 minutes and the stock is released", async () => {
    const p = await makeProduct(w, { name: "Grip tape", category: "ACCESSORIES", price: 30000, onHand: 2 });
    const o = await checkout(PUBLIC, { items: [{ variantId: p.variantId, qty: 2 }], fulfilment: "PICKUP", paymentOption: "ONLINE", guest: visitor });
    expect(o.status).toBe("PENDING_PAYMENT");
    expect(o.payment?.redirectUrl).toMatch(/^\/pay\/test\//);
    expect((await stock(p.variantId)).reserved).toBe(2);
    clock.advance(14 * 60_000);
    expect((await expireHolds()).cancelled).toBe(0);
    clock.advance(2 * 60_000);
    expect((await expireHolds()).cancelled).toBe(1);
    expect((await stock(p.variantId)).reserved).toBe(0);
    // Paying after the hold expired → the money goes straight back.
    const r = await payOnline(o.payment!.paymentId);
    expect(r.refunded).toBe(60000);
    await expectIntegrity();
  });

  it("SH-5: pay-at-pickup holds for 48 hours, then auto-cancels", async () => {
    const m = await makeMember(w, { name: "Slow Collector", plan: "SILVER" });
    const p = await makeProduct(w, { name: "Cap", category: "APPAREL", price: 70000, onHand: 3 });
    await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    clock.advance(47 * 3600_000);
    expect((await expireHolds()).cancelled).toBe(0);
    clock.advance(2 * 3600_000);
    expect((await expireHolds()).cancelled).toBe(1);
    expect((await stock(p.variantId)).reserved).toBe(0);
  });

  it("SH-6: pickup flow — paid online → CONFIRMED → READY → COLLECTED takes the units off the shelf", async () => {
    const p = await makeProduct(w, { name: "Shoes Max", category: "SHOES", price: 450000, onHand: 3 });
    const o = await checkout(PUBLIC, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "ONLINE", guest: visitor });
    await payOnline(o.payment!.paymentId);
    expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("CONFIRMED");
    await expect(setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "COLLECTED")).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "READY_FOR_PICKUP");
    await setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "COLLECTED");
    const v = await stock(p.variantId);
    expect([v.onHand, v.reserved]).toEqual([2, 0]);
    await expect(cancelOrder(w.actors.SHOP_STAFF, o.orderId, "too late")).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expectIntegrity();
  });

  it("SH-6: pay-at-pickup must be fully paid before COLLECTED; delivery adds the undiscounted fee", async () => {
    const m = await makeMember(w, { name: "Picker Pia", plan: "GOLD" });
    const p = await makeProduct(w, { name: "Bag", category: "ACCESSORIES", price: 200000, onHand: 3 });
    const o = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    await setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "READY_FOR_PICKUP");
    await expect(setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "COLLECTED")).rejects.toMatchObject({ code: "PAYMENT_DUE" });
    await recordCounterPayment(w.actors.SHOP_STAFF, { billId: o.billId, method: "CARD", ...CARD_PROOF, amount: o.total });
    await setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "COLLECTED");
    const d = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", address: "12 Lake View Road, Ahmedabad 380015", pincode: "380015", paymentOption: "ONLINE" });
    expect(d.total).toBe(170000 + 9900);
    await expect(checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", paymentOption: "PAY_AT_PICKUP", address: "12 Lake View Road, Ahmedabad", pincode: "380015" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await payOnline(d.payment!.paymentId);
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "PACKED");
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "OUT_FOR_DELIVERY");
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "DELIVERED");
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "ORDER_STATUS" } })).toBeGreaterThanOrEqual(4);
    await expectIntegrity();
  });

  it("cancelling a paid online order releases stock and refunds through the gateway; members cancel only their own", async () => {
    const a = await makeMember(w, { name: "Canceller", plan: "SILVER" });
    const b = await makeMember(w, { name: "Bystander", plan: "SILVER" });
    const p = await makeProduct(w, { name: "Socks", category: "APPAREL", price: 40000, onHand: 5 });
    const o = await checkout(a.actor, { items: [{ variantId: p.variantId, qty: 2 }], fulfilment: "PICKUP", paymentOption: "ONLINE" });
    await payOnline(o.payment!.paymentId);
    await expect(cancelOrder(b.actor, o.orderId, "not mine")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const c = await cancelOrder(a.actor, o.orderId, "changed my mind");
    expect(c.refunded).toBe(72000);
    expect((await stock(p.variantId)).reserved).toBe(0);
    await expectIntegrity();
  });
});

describe("Phase 4 — receipts, adjustments, returns, payables (SH-3, SH-9, SH-10, EX-1)", () => {
  it("SH-9: a goods receipt with a supplier bill creates a payable; paying it writes an OUT ledger entry", async () => {
    const p = await makeProduct(w, { name: "Balls box", category: "BALLS", price: 50000 });
    const r = await receiveStock(w.actors.SHOP_STAFF, { variantId: p.variantId, qty: 24, unitCost: 30000, supplier: "Sports Wholesale Ltd", createPayable: true, inputGst: 77143 });
    const e = await prisma.expenseBill.findUniqueOrThrow({ where: { id: r.expenseId! } });
    expect([e.category, e.amount, e.status]).toEqual(["STOCK_PURCHASE", 720000, "UNPAID"]);
    await expect(payExpense(w.actors.SHOP_STAFF, e.id, { method: "UPI", reference: utr() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await payExpense(w.actors.ACCOUNTANT, e.id, { method: "UPI", reference: utr() });
    const l = await prisma.ledgerEntry.findFirstOrThrow({ where: { refId: e.id } });
    expect([l.source, l.direction, l.amount]).toEqual(["EXPENSE", "OUT", -720000]);
  });

  it("SH-3: adjustments can't remove reserved units; stock always equals the sum of movements", async () => {
    const m = await makeMember(w, { name: "Reserver", plan: "SILVER" });
    const p = await makeProduct(w, { name: "Headband", category: "APPAREL", price: 25000, onHand: 3 });
    await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 2 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    await expect(adjustStock(w.actors.SHOP_STAFF, { variantId: p.variantId, delta: -2, reason: "damaged" })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await adjustStock(w.actors.SHOP_STAFF, { variantId: p.variantId, delta: -1, reason: "damaged in storage" });
    await expectIntegrity();
  });

  it("SH-10: a return within 7 days restocks and refunds the returned quantity", async () => {
    const p = await makeProduct(w, { name: "Shirt", category: "APPAREL", price: 120000, onHand: 5 });
    const r = await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: p.variantId, qty: 2 }], payments: [{ method: "CARD", ...CARD_PROOF }] });
    const line = await prisma.billLine.findFirstOrThrow({ where: { billId: r.billId } });
    const ret = await returnItems(w.actors.SHOP_STAFF, { billId: r.billId, lines: [{ billLineId: line.id, qty: 1 }], reference: "RFND03", reason: "wrong size" });
    expect(ret.refunded).toBe(120000);
    expect((await stock(p.variantId)).onHand).toBe(4);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
    expect([bill.total, bill.amountPaid - bill.amountRefunded, bill.status]).toEqual([120000, 120000, "PAID"]);
    clock.advance(8 * 86_400_000);
    const line2 = await prisma.billLine.findFirstOrThrow({ where: { billId: r.billId, voidedAt: null } });
    await expect(returnItems(w.actors.SHOP_STAFF, { billId: r.billId, lines: [{ billLineId: line2.id, qty: 1 }], reason: "late" })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expectIntegrity();
  });
});
