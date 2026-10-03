// v3 phase 8 (§3.2): the shop lists on the standard FilterBar — online orders, counter sales, stock, stock movements,
// purchase orders and stock takes. Each: it runs, a facet narrows the rows with the right count, the summary strip
// adds up for a small fixture, and a role that may not see the list is refused.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { PUBLIC } from "@/server/rbac/actor";
import { listView } from "@/server/services/filters";
import { adjustStock } from "@/server/services/inventory";
import { verifyOnlinePayment } from "@/server/services/payments";
import { testGateway } from "@/server/services/gateway";
import { cancelOrder, checkout, counterSale, setOrderStatus } from "@/server/services/shop";
import { cancelPurchaseOrder, createPurchaseOrder, markOrdered, postStockTake } from "@/server/services/purchasing";
import { makeWorld, T0, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const visitor = { name: "Visitor Vee", phone: "9876500001", email: "vee@example.com" };

async function payOnline(paymentId: string) {
  const gpid = testGateway.newGatewayPaymentId();
  return verifyOnlinePayment(paymentId, { gatewayPaymentId: gpid, outcome: "SUCCESS", signature: testGateway.sign(paymentId, gpid, "SUCCESS") });
}

const summaryOf = (r: { summary: Array<{ key: string; value: number }> }) => Object.fromEntries(r.summary.map((s) => [s.key, s.value]));
const facetCount = (r: { facets: Array<{ key: string; options: Array<{ value: string; count: number }> }> }, key: string, value: string) =>
  r.facets.find((f) => f.key === key)!.options.find((o) => o.value === value)?.count ?? 0;

describe("v3 §3.2 — shop lists", () => {
  it("orders: opens on open orders; fulfilment and customer facets narrow; summary counts the board and today's takings", async () => {
    const m = await makeMember(w, { name: "Order Omar", plan: "SILVER" });
    const p = await makeProduct(w, { name: "Grip Pro", category: "ACCESSORIES", price: 50000, onHand: 20 });
    const confirmed = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    const ready = await checkout(PUBLIC, { items: [{ variantId: p.variantId, qty: 2 }], fulfilment: "PICKUP", paymentOption: "ONLINE", guest: visitor });
    await payOnline(ready.payment!.paymentId);
    await setOrderStatus(w.actors.SHOP_STAFF, ready.orderId, "READY_FOR_PICKUP");
    const out = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "DELIVERY", address: "12 Lake View Road, Ahmedabad 380015", pincode: "380015", paymentOption: "ONLINE" });
    await payOnline(out.payment!.paymentId);
    await setOrderStatus(w.actors.SHOP_STAFF, out.orderId, "PACKED");
    await setOrderStatus(w.actors.SHOP_STAFF, out.orderId, "OUT_FOR_DELIVERY");
    const cancelled = await checkout(m.actor, { items: [{ variantId: p.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    await cancelOrder(w.actors.SHOP_STAFF, cancelled.orderId, "changed mind");

    const r = await listView(w.actors.SHOP_STAFF, "orders", {});
    expect(r.total).toBe(3); // the cancelled order is not open
    expect(r.query.status).toBe("PENDING_PAYMENT,CONFIRMED,READY_FOR_PICKUP,PACKED,OUT_FOR_DELIVERY");
    const s = summaryOf(r);
    expect([s.prepare, s.ready, s.out]).toEqual([1, 1, 1]);
    expect(s.today).toBe(confirmed.total + ready.total + out.total);
    const row = r.rows.find((x) => x.id === confirmed.orderId)!;
    expect([row.next_statuses, row.due, row.customer_kind]).toEqual([["READY_FOR_PICKUP"], confirmed.total, "member"]);
    expect(facetCount(r, "fulfilment", "DELIVERY")).toBe(1);

    const delivery = await listView(w.actors.SHOP_STAFF, "orders", { fulfilment: "DELIVERY" });
    expect([delivery.total, delivery.rows[0].id]).toEqual([1, out.orderId]);
    expect((await listView(w.actors.MANAGER, "orders", { customer: "guest" })).total).toBe(1);
    expect((await listView(w.actors.MANAGER, "orders", { status: "CANCELLED" })).total).toBe(1);

    await expect(listView(w.actors.FRONT_DESK, "orders", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.BAR_STAFF, "orders", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("sales: opens on today; payment method, customer and staff facets narrow; summary is count, total and discounts", async () => {
    const a = await makeProduct(w, { name: "Tennis balls (3)", category: "BALLS", price: 50000, onHand: 20 });
    const b = await makeProduct(w, { name: "Court shoes", category: "SHOES", price: 600000, onHand: 5 });
    const neha = await makeMember(w, { name: "Neha", plan: "SILVER" });
    // Yesterday's sale: rung up now, then dated a day back (the list reads the sale's own time).
    const y = await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: a.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    await prisma.counterSale.update({ where: { id: y.saleId }, data: { createdAt: new Date(T0.getTime() - 24 * 3600_000) } });
    const s1 = await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: a.variantId, qty: 2 }], payments: [{ method: "CASH" }] });
    const s2 = await counterSale(w.actors.MANAGER, { memberId: neha.memberId, items: [{ variantId: b.variantId, qty: 1 }], payments: [{ method: "UPI", reference: utr() }] });

    const r = await listView(w.actors.SHOP_STAFF, "sales", {});
    expect([r.total, r.query.range]).toEqual([2, "TODAY"]);
    const s = summaryOf(r);
    expect([s.count, s.total, s.discount]).toEqual([2, s1.total + s2.total, s1.discountTotal + s2.discountTotal]);
    expect(s2.discountTotal).toBeGreaterThan(0);
    expect([facetCount(r, "method", "CASH"), facetCount(r, "method", "UPI")]).toEqual([1, 1]);

    const upi = await listView(w.actors.SHOP_STAFF, "sales", { method: "UPI" });
    expect([upi.total, upi.rows[0].member_id]).toEqual([1, neha.memberId]);
    expect((await listView(w.actors.SHOP_STAFF, "sales", { customer: "walkin" })).total).toBe(2); // yesterday's and today's walk-ins
    expect((await listView(w.actors.SHOP_STAFF, "sales", { range: "TODAY", staff: w.actors.MANAGER.userId })).total).toBe(1);
    expect((await listView(w.actors.SHOP_STAFF, "sales", { range: "YESTERDAY" })).total).toBe(1);

    await expect(listView(w.actors.BAR_STAFF, "sales", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.ACCOUNTANT, "sales", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stock: ?filter=low still lists what is low; category narrows; archived items are hidden by default", async () => {
    const low = await makeProduct(w, { name: "Low Racket", category: "RACKETS", price: 1000000, onHand: 2, reorderLevel: 3 });
    const plenty = await makeProduct(w, { name: "Plenty Balls", category: "BALLS", price: 30000, onHand: 10, reorderLevel: 3 });
    const empty = await makeProduct(w, { name: "Empty Grip", category: "ACCESSORIES", price: 20000, reorderLevel: 3 });
    const old = await makeProduct(w, { name: "Old Cap", category: "APPAREL", price: 40000, onHand: 1, reorderLevel: 3 });
    await prisma.product.update({ where: { id: old.productId }, data: { archivedAt: T0 } });

    const r = await listView(w.actors.SHOP_STAFF, "stock", {});
    expect([r.total, r.query.archived]).toEqual([3, "no"]);
    const s = summaryOf(r);
    expect([s.items, s.low, s.out, s.value]).toEqual([3, 2, 1, 2 * 1000000 + 10 * 30000]);

    const lowOnly = await listView(w.actors.SHOP_STAFF, "stock", { filter: "low" });
    expect(lowOnly.rows.map((x) => x.variant_id).sort()).toEqual([low.variantId, empty.variantId].sort());
    expect((await listView(w.actors.SHOP_STAFF, "stock", { filter: "out" })).rows.map((x) => x.variant_id)).toEqual([empty.variantId]);
    const balls = await listView(w.actors.FRONT_DESK, "stock", { category: "BALLS" });
    expect([balls.total, balls.rows[0].variant_id]).toEqual([1, plenty.variantId]);
    expect(facetCount(r, "category", "RACKETS")).toBe(1);
    expect((await listView(w.actors.SHOP_STAFF, "stock", { archived: "yes" })).rows.map((x) => x.variant_id)).toEqual([old.variantId]);

    await expect(listView(w.actors.BAR_STAFF, "stock", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("movements: receipts, sales and adjustments in the last 7 days; type, product, category and staff facets narrow", async () => {
    const a = await makeProduct(w, { name: "Overgrip", category: "ACCESSORIES", price: 25000, onHand: 5 });
    const b = await makeProduct(w, { name: "Shuttle tube", category: "BALLS", price: 90000, onHand: 3 });
    await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: a.variantId, qty: 2 }], payments: [{ method: "CASH" }] });
    await adjustStock(w.actors.MANAGER, { variantId: b.variantId, delta: -1, reason: "damaged in storage" });

    const r = await listView(w.actors.SHOP_STAFF, "movements", {});
    expect([r.total, r.query.range]).toEqual([4, "LAST_7"]);
    const s = summaryOf(r);
    expect([s.received, s.sold, s.returned, s.adjusted]).toEqual([8, 2, 0, 1]);
    expect(r.rows.find((x) => x.reason === "COUNTER_SALE")!.ref_code).toMatch(/\S/);

    expect((await listView(w.actors.SHOP_STAFF, "movements", { type: "ADJUSTMENT" })).total).toBe(1);
    expect((await listView(w.actors.SHOP_STAFF, "movements", { product: a.productId })).total).toBe(2);
    expect((await listView(w.actors.SHOP_STAFF, "movements", { category: "BALLS" })).total).toBe(2);
    expect((await listView(w.actors.SHOP_STAFF, "movements", { staff: w.actors.MANAGER.userId })).total).toBe(1);
    expect(facetCount(r, "type", "RECEIPT")).toBe(2);

    await expect(listView(w.actors.BAR_STAFF, "movements", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("purchase orders: drafts first; supplier and status facets narrow; summary counts drafts, orders awaiting goods and their value", async () => {
    const p = await makeProduct(w, { name: "Strings reel", category: "ACCESSORIES", price: 80000 });
    const ordered = await createPurchaseOrder(w.actors.SHOP_STAFF, { supplier: "Sports Wholesale", lines: [{ variantId: p.variantId, qty: 10, unitCost: 9000 }] });
    await markOrdered(w.actors.SHOP_STAFF, ordered.id);
    const draft = await createPurchaseOrder(w.actors.SHOP_STAFF, { supplier: "Racket House", lines: [{ variantId: p.variantId, qty: 2, unitCost: 50000 }] });
    const gone = await createPurchaseOrder(w.actors.MANAGER, { supplier: "Sports Wholesale", lines: [{ variantId: p.variantId, qty: 1, unitCost: 1000 }] });
    await cancelPurchaseOrder(w.actors.MANAGER, gone.id, "duplicate order");

    const r = await listView(w.actors.SHOP_STAFF, "purchase-orders", {});
    expect(r.total).toBe(3);
    expect(r.rows[0].code).toBe(draft.code);
    const s = summaryOf(r);
    expect([s.drafts, s.ordered, s.on_order, s.received]).toEqual([1, 1, 90000, 0]);
    expect(facetCount(r, "supplier", "Sports Wholesale")).toBe(2);
    expect((await listView(w.actors.SHOP_STAFF, "purchase-orders", { supplier: "Sports Wholesale" })).total).toBe(2);
    const c = await listView(w.actors.FRONT_DESK, "purchase-orders", { status: "CANCELLED" });
    expect([c.total, c.rows[0].code]).toEqual([1, gone.code]);

    await expect(listView(w.actors.BAR_STAFF, "purchase-orders", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.ACCOUNTANT, "purchase-orders", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stock takes: every count with its differences; the result facet narrows; summary counts takes and units short / over", async () => {
    const a = await makeProduct(w, { name: "Ball can", category: "BALLS", price: 50000, onHand: 10 });
    const b = await makeProduct(w, { name: "Wristband", category: "ACCESSORIES", price: 20000, onHand: 5 });
    await postStockTake(w.actors.SHOP_STAFF, { lines: [{ variantId: a.variantId, counted: 8 }, { variantId: b.variantId, counted: 5 }] });
    await postStockTake(w.actors.MANAGER, { lines: [{ variantId: b.variantId, counted: 6 }] });
    const matched = await postStockTake(w.actors.SHOP_STAFF, { lines: [{ variantId: a.variantId, counted: 8 }] });

    const r = await listView(w.actors.SHOP_STAFF, "stock-takes", {});
    expect(r.total).toBe(3);
    const s = summaryOf(r);
    expect([s.takes, s.adjusted, s.short, s.surplus]).toEqual([3, 2, 2, 1]);
    expect(facetCount(r, "status", "MATCHED")).toBe(1);
    const m = await listView(w.actors.SHOP_STAFF, "stock-takes", { status: "MATCHED" });
    expect([m.total, m.rows[0].code]).toEqual([1, matched.code]);
    expect((await listView(w.actors.OWNER, "stock-takes", { staff: w.actors.MANAGER.userId })).total).toBe(1);

    await expect(listView(w.actors.FRONT_DESK, "stock-takes", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
