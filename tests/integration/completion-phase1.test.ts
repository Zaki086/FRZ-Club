// Completion pass phase 1: "real or absent" — capabilities, payment proof, cash drawers, pending refunds,
// Razorpay webhook + status check (completion pass §1, §2, 8.4).
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, withTx } from "@/server/db";
import { createBill } from "@/server/services/bills";
import { getSettings, updateSetting } from "@/server/services/settings";
import { priceLine } from "@/server/services/pricing";
import {
  completeRefund,
  failStalePendingPayments,
  handleRazorpayWebhook,
  listPendingRefunds,
  recordCounterPayment,
  startOnlinePayment,
} from "@/server/services/payments";
import { publicCapabilities, setCapabilityOverridesForTests, assertCapability, invalidateCapabilities } from "@/server/services/capabilities";
import { closeDrawer, dailyCashReconciliation, myDrawer, openDrawer, recordDeposit } from "@/server/services/drawers";
import { checkout, setOrderStatus } from "@/server/services/shop";
import { testGateway } from "@/server/services/gateway";
import { verifyOnlinePayment } from "@/server/services/payments";
import { makeProduct } from "../helpers/shop";
import { makeMember } from "../helpers/members";
import { clock } from "@/lib/clock";
import { makeWorld, type World, utr, CARD_PROOF, TEST_UPI_VPA } from "../helpers/world";
import { withFloat } from "../helpers/drawer";
import { expectIntegrity } from "../helpers/integrity";
import { approvedRefund } from "../helpers/refunds";
import { requestRefund } from "@/server/services/refunds";

let w: World;

async function makeBill(amount: number, source: "BOOKING" | "COUNTER_SALE" | "INVOICE" = "BOOKING") {
  const s = await getSettings();
  const g = await prisma.guest.create({ data: { name: "Tess Tender" } });
  return withTx((tx) =>
    createBill(tx, {
      sourceType: source,
      customer: { guestId: g.id, name: g.name },
      tier: "WALK_IN",
      lines: [priceLine({ description: "Test line", qty: 1, unitPrice: amount, taxCategory: "COURT", hsnSac: "999652", explanation: "test" }, s)],
    }),
  );
}

beforeEach(async () => {
  w = await makeWorld();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
});

describe("Completion §1 — capabilities: off → CAPABILITY_DISABLED and absent from the payload; on → works", () => {
  it("card: off rejects card payments and hides CARD; on accepts them with proof", async () => {
    const bill = await makeBill(10000);
    await updateSetting(w.actors.OWNER, "payment_methods", { card_enabled: false, upi_vpa: TEST_UPI_VPA, upi_confirmed: true });
    expect((await publicCapabilities()).counterMethods).toEqual(["CASH", "UPI"]);
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CARD", amount: 10000, ...CARD_PROOF })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await updateSetting(w.actors.OWNER, "payment_methods", { card_enabled: true, upi_vpa: TEST_UPI_VPA, upi_confirmed: true });
    expect((await publicCapabilities()).counterMethods).toEqual(["CASH", "CARD", "UPI"]);
    const ok = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CARD", amount: 10000, ...CARD_PROOF });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: ok.paymentId } })).cardLast4).toBe("4242");
  });

  it("UPI: needs a valid VPA AND the Owner's confirmation; the payload carries the VPA only when on", async () => {
    const bill = await makeBill(10000);
    await updateSetting(w.actors.OWNER, "payment_methods", { card_enabled: true, upi_vpa: TEST_UPI_VPA, upi_confirmed: false });
    let pub = await publicCapabilities();
    expect(pub.counterMethods).not.toContain("UPI");
    expect(pub.upiVpa).toBeNull();
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: 10000, reference: utr() })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await updateSetting(w.actors.OWNER, "payment_methods", { card_enabled: true, upi_vpa: "not a vpa", upi_confirmed: true });
    expect((await publicCapabilities()).counterMethods).not.toContain("UPI");
    await updateSetting(w.actors.OWNER, "payment_methods", { card_enabled: true, upi_vpa: TEST_UPI_VPA, upi_confirmed: true });
    pub = await publicCapabilities();
    expect(pub.upiVpa).toBe(TEST_UPI_VPA);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: 10000, reference: utr() });
  });

  it("online: off → startOnlinePayment is CAPABILITY_DISABLED and the payload says online:false", async () => {
    const bill = await makeBill(10000);
    setCapabilityOverridesForTests({ "payments.online": false });
    expect((await publicCapabilities()).online).toBe(false);
    await expect(startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/x")).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    setCapabilityOverridesForTests({});
    expect((await publicCapabilities()).online).toBe(true);
  });

  it("email, delivery and gst report their state; delivery carries fee and PIN codes only when on", async () => {
    setCapabilityOverridesForTests({ email: false });
    await expect(assertCapability("email")).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect((await publicCapabilities()).email).toBe(false);
    setCapabilityOverridesForTests({ email: true });
    expect((await publicCapabilities()).delivery).toEqual({ fee: 9900, pincodes: ["380015", "380009", "380054"] });
    expect((await publicCapabilities()).gst).toBe(true);
    await updateSetting(w.actors.OWNER, "delivery", { enabled: false, pincodes: ["380015"], fee: 9900 });
    expect((await publicCapabilities()).delivery).toBeNull();
    await updateSetting(w.actors.OWNER, "delivery", { enabled: true, pincodes: [], fee: 9900 });
    expect((await publicCapabilities()).delivery).toBeNull();
  });
});

describe("Completion §2 — payment proof", () => {
  it("UPI needs a 12-character UTR; card needs an approval code and the last 4 digits", async () => {
    const bill = await makeBill(30000);
    const pay = (x: object) => recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, amount: 10000, ...x } as never);
    await expect(pay({ method: "UPI" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay({ method: "UPI", reference: "UTR123" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay({ method: "CARD", cardLast4: "4242" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay({ method: "CARD", approvalCode: "AUTH01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay({ method: "CARD", approvalCode: "AUTH01", cardLast4: "42" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay({ method: "BANK_TRANSFER", reference: "NEFT1234" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // invoices only
    await pay({ method: "UPI", reference: utr() });
    const c = await prisma.payment.findUniqueOrThrow({ where: { id: (await pay({ method: "CARD", ...CARD_PROOF })).paymentId } });
    expect([c.cardLast4, c.approvalCode]).toEqual(["4242", "AUTH01"]);
  });
});

describe("Completion 8.4 — cash drawers", () => {
  it("counter payments need an open drawer; closing computes expected cash and the variance", async () => {
    const bill = await makeBill(50000);
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 0 });
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 20000 })).rejects.toMatchObject({ code: "DRAWER_NOT_OPEN" });
    await openDrawer(w.actors.FRONT_DESK, { area: "DESK", openingFloat: 100000 });
    await expect(openDrawer(w.actors.FRONT_DESK, { area: "DESK", openingFloat: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 20000 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: 30000, reference: utr() });
    const live = await myDrawer(w.actors.FRONT_DESK);
    expect([live.open?.cashExpected, live.open?.upi]).toEqual([120000, 30000]);
    const closed = await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 119000 });
    expect([closed.cashExpected, closed.variance, closed.upiTotal]).toEqual([120000, -1000, 30000]);
    expect(await prisma.notification.count({ where: { type: "CASH_VARIANCE" } })).toBeGreaterThan(0);
    const rec = await dailyCashReconciliation(w.actors.ACCOUNTANT);
    const mine = rec.sessions.find((s) => s.id === closed.id)!;
    expect(mine.variance).toBe(-1000);
    await expect(recordDeposit(w.actors.ACCOUNTANT, closed.id, { amount: 200000, reference: "DEP-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await recordDeposit(w.actors.ACCOUNTANT, closed.id, { amount: 119000, reference: "DEP-1" });
    await expect(dailyCashReconciliation(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectIntegrity();
  });
});

describe("Completion §2.7 — refunds only through enabled methods", () => {
  it("a UPI refund without a UTR becomes PENDING; the desk pays it out later with proof", async () => {
    const bill = await makeBill(40000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: 40000, reference: utr() });
    const r = await approvedRefund(w, bill.id, 15000);
    expect([r.refunded, r.pending]).toEqual([0, 15000]);
    expect(await prisma.ledgerEntry.count({ where: { billId: bill.id, amount: { lt: 0 } } })).toBe(0);
    await expect(requestRefund(w.actors.MANAGER, { billId: bill.id, amount: 30000, reason: "OTHER", note: "too much" })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
    const pending = await listPendingRefunds(w.actors.FRONT_DESK);
    expect(pending.map((p) => p.amount)).toEqual([15000]);
    await expect(completeRefund(w.actors.FRONT_DESK, pending[0].id, { method: "UPI" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await withFloat(w.actors.FRONT_DESK, 20000); // v4 RF-9: cash refunds are paid from cash in the drawer
    await completeRefund(w.actors.FRONT_DESK, pending[0].id, { method: "CASH" });
    expect((await prisma.ledgerEntry.findFirstOrThrow({ where: { billId: bill.id, amount: { lt: 0 } } })).amount).toBe(-15000);
    expect(await listPendingRefunds(w.actors.FRONT_DESK)).toEqual([]);
    await expectIntegrity();
  });

  it("an online payment refunded while online payments are off is PENDING for the desk", async () => {
    const bill = await makeBill(25000);
    const s = await startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/x");
    const gp = testGateway.newGatewayPaymentId();
    await verifyOnlinePayment(s.paymentId, { gatewayPaymentId: gp, outcome: "SUCCESS", signature: testGateway.sign(s.paymentId, gp, "SUCCESS") });
    setCapabilityOverridesForTests({ "payments.online": false, email: true });
    const r = await approvedRefund(w, bill.id, 25000);
    expect(r.pending).toBe(25000);
    setCapabilityOverridesForTests({ email: true });
    const r2 = await requestRefund(w.actors.MANAGER, { billId: bill.id, amount: 1, reason: "OTHER", note: "rounding" }).catch((e: unknown) => e);
    expect(r2).toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
    await expectIntegrity();
  });
});

describe("Completion §2.6 — Razorpay webhook and status check (fetch mocked)", () => {
  async function pendingRazorpay(amount: number, orderId: string) {
    const bill = await makeBill(amount);
    const p = await prisma.payment.create({
      data: { billId: bill.id, type: "PAYMENT", method: "ONLINE", amount, status: "PENDING", gateway: "RAZORPAY", gatewayOrderId: orderId, occurredAt: clock.now() },
    });
    return { bill, p };
  }

  it("rejects a bad signature; payment.captured settles once (replays are no-ops)", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_1234567890";
    const { bill, p } = await pendingRazorpay(30000, "order_W1");
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_W1", order_id: "order_W1", status: "captured" } } } });
    await expect(handleRazorpayWebhook(body, "bad")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const sig = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest("hex");
    expect(await handleRazorpayWebhook(body, sig)).toMatchObject({ handled: true, status: "SUCCEEDED", replayed: false });
    expect(await handleRazorpayWebhook(body, sig)).toMatchObject({ handled: true, replayed: true });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).gatewayPaymentId).toBe("pay_W1");
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");
    await expectIntegrity();
  });

  it("the stale-payment job asks Razorpay first: captured → SUCCEEDED, otherwise FAILED", async () => {
    const a = await pendingRazorpay(10000, "order_S1");
    const b = await pendingRazorpay(20000, "order_S2");
    vi.stubGlobal("fetch", async (url: string) => {
      const items = String(url).includes("order_S1") ? [{ id: "pay_S1", order_id: "order_S1", status: "captured", amount: 10000 }] : [{ id: "pay_S2", order_id: "order_S2", status: "failed", amount: 20000 }];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });
    clock.advance(60 * 60_000);
    expect(await failStalePendingPayments(30)).toEqual({ failed: 1, captured: 1 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.p.id } })).status).toBe("SUCCEEDED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: b.p.id } })).status).toBe("FAILED");
    await expectIntegrity();
  });
});

describe("Completion §2.3 — checkout options follow the capabilities", () => {
  it("online off: members pay at pickup, delivery is pay-on-delivery and only DELIVERED after payment", async () => {
    const m = await makeMember(w, { name: "Offline Olu", plan: "GOLD" });
    const p = await makeProduct(w, { name: "Grip", category: "ACCESSORIES", price: 30000, onHand: 5 });
    setCapabilityOverridesForTests({ "payments.online": false, email: true });
    await expect(checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "ONLINE" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await expect(checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", address: "1 Elsewhere Road, Surat", pincode: "395007", paymentOption: "PAY_ON_DELIVERY" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const d = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", address: "12 Lake View Road, Ahmedabad", pincode: "380015", paymentOption: "PAY_ON_DELIVERY" });
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "PACKED");
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "OUT_FOR_DELIVERY");
    await expect(setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "DELIVERED")).rejects.toMatchObject({ code: "PAYMENT_DUE" });
    await recordCounterPayment(w.actors.SHOP_STAFF, { billId: d.billId, method: "CASH", amount: d.total });
    await setOrderStatus(w.actors.SHOP_STAFF, d.orderId, "DELIVERED");
    await updateSetting(w.actors.OWNER, "delivery", { enabled: false, pincodes: [], fee: 9900 });
    invalidateCapabilities();
    await expect(checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", address: "12 Lake View Road, Ahmedabad", pincode: "380015", paymentOption: "PAY_ON_DELIVERY" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await expectIntegrity();
  });
});
