import { beforeEach, describe, expect, it } from "vitest";
import { prisma, withTx } from "@/server/db";
import { createBill } from "@/server/services/bills";
import { getSettings } from "@/server/services/settings";
import { priceLine, quoteCourt, quoteShop, quoteManual } from "@/server/services/pricing";
import {
  listPendingRefunds,
  recordCounterPayment,
  startOnlinePayment,
  verifyOnlinePayment,
} from "@/server/services/payments";
import { testGateway } from "@/server/services/gateway";
import { makeWorld, type World, utr, CARD_PROOF } from "../helpers/world";
import { withFloat } from "../helpers/drawer";
import { expectIntegrity } from "../helpers/integrity";
import { approvedRefund } from "../helpers/refunds";
import { payOutRefund, requestRefund, approveRefund } from "@/server/services/refunds";

let w: World;

async function guest(name: string) {
  return prisma.guest.create({ data: { name } });
}

async function makeBill(amountPaise: number, source: "BOOKING" | "COUNTER_SALE" = "BOOKING") {
  const s = await getSettings();
  const g = await guest("Walk-in Wally");
  return withTx((tx) =>
    createBill(tx, {
      sourceType: source,
      customer: { guestId: g.id, name: g.name },
      tier: "WALK_IN",
      lines: [priceLine({ description: "Test line", qty: 1, unitPrice: amountPaise, taxCategory: "COURT", hsnSac: "999652", explanation: "test" }, s)],
    }),
  );
}

beforeEach(async () => {
  w = await makeWorld();
});

describe("Phase 1 — pricing engine (§5.3)", () => {
  it("PR-2: a line carries discount, net, GST extracted from the inclusive price and an explanation", async () => {
    const s = await getSettings();
    const l = priceLine({ description: "Racket", qty: 2, unitPrice: 499900, discountPct: 10, taxCategory: "GOODS_5", hsnSac: "9506", explanation: "Silver member · 10% shop discount" }, s);
    expect(l.discountAmount).toBe(99980);
    expect(l.netAmount).toBe(899820);
    expect(l.taxRate).toBe(5);
    expect(l.taxAmount).toBe(Math.floor((899820 * 5 * 2 + 105) / (2 * 105)));
    expect(l.explanation).toMatch(/10% shop discount/);
  });

  it("PR-4: walk-in court fee is ₹400 per player from settings, recorded per player", async () => {
    const g1 = await guest("Guest One");
    const g2 = await guest("Guest Two");
    const q = await quoteCourt(prisma, {
      sport: "TENNIS", date: "2026-10-12", courtName: "Court 1", timeLabel: "18:00–19:00",
      players: [{ guestId: g1.id, name: g1.name }, { guestId: g2.id, name: g2.name }],
    });
    expect(q.players.map((p) => p.netAmount)).toEqual([40000, 40000]);
    expect(q.total).toBe(80000);
    expect(q.players[0].explanation).toMatch(/Walk-in rate · ₹400/);
  });

  it("PR-5: walk-in shop prices carry no discount; delivery fee is never discounted", async () => {
    const q = await quoteShop(prisma, {
      date: "2026-10-12",
      items: [{ variantId: "v1", qty: 1, name: "Balls", price: 50000, taxCategory: "GOODS_5", hsnSac: "9506" }],
      deliveryFee: 9900,
    });
    expect(q.total).toBe(59900);
    expect(q.lines[1].discountAmount).toBe(0);
    expect(q.lines[1].explanation).toMatch(/never discounted/);
  });

  it("PR-8: bill lines are immutable snapshots at the database level", async () => {
    const bill = await makeBill(55000);
    const line = await prisma.billLine.findFirstOrThrow({ where: { billId: bill.id } });
    await expect(prisma.billLine.update({ where: { id: line.id }, data: { unitPrice: 1 } })).rejects.toThrow(/immutable/);
  });

  it("manual invoice lines are priced as entered", async () => {
    const q = quoteManual([{ description: "Corporate court package", qty: 1, unitPrice: 2360000 }], await getSettings());
    expect(q.total).toBe(2360000);
    expect(q.taxTotal).toBe(360000);
  });
});

describe("Phase 1 — payments, refunds and the ledger (§5.10)", () => {
  it("PY-4: overpayment is rejected; partial payment leaves the bill PARTIAL", async () => {
    const bill = await makeBill(55000);
    await expect(
      recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 60000 }),
    ).rejects.toMatchObject({ code: "OVERPAYMENT", message: expect.stringMatching(/₹600 is more than the ₹550 still due/) });
    const r = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", reference: utr(), amount: 20000 });
    expect(r.billStatus).toBe("PARTIAL");
    expect(r.due).toBe(35000);
    await withFloat(w.actors.FRONT_DESK, 20000); // v4 CD-4: the change comes from cash already in the drawer
    const r2 = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 35000, tendered: 50000 });
    expect(r2.billStatus).toBe("PAID");
    expect(r2.changeGiven).toBe(15000);
    await expectIntegrity();
  });

  it("PY-4: a refund can't exceed the amount paid; refunds are negative IN entries under the original source", async () => {
    const bill = await makeBill(55000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CARD", amount: 55000, ...CARD_PROOF });
    // v3 RF-3: a discretionary refund is asked for, approved by someone else, then paid out at the desk (D-68).
    await expect(
      requestRefund(w.actors.MANAGER, { billId: bill.id, amount: 60000, reason: "GOODWILL", note: "test" }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
    const r = await approvedRefund(w, bill.id, 15000);
    expect(r.pending).toBe(15000);
    const done = await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CARD", approvalCode: "RFND01", identityChecked: true }); // v4 RF-9: identity tick
    expect(done.status).toBe("COMPLETED");
    const ledger = await prisma.ledgerEntry.findMany({ where: { billId: bill.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.source, l.direction, l.amount])).toEqual([
      ["COURTS", "IN", 55000],
      ["COURTS", "IN", -15000],
    ]);
    await expectIntegrity();
  });

  it("RBAC (v3 RF-1/RF-3): the desk may ask for a refund but only OWNER/MANAGER approve; bar staff can't ask on a court bill", async () => {
    const bill = await makeBill(10000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 10000 });
    await expect(requestRefund(w.actors.BAR_STAFF, { billId: bill.id, amount: 100, reason: "OTHER", note: "nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const req = await requestRefund(w.actors.FRONT_DESK, { billId: bill.id, amount: 100, reason: "OTHER", note: "rounding" });
    await expect(approveRefund(w.actors.FRONT_DESK, req.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listPendingRefunds(w.actors.FRONT_DESK)).toEqual([]);
  });

  it("RBAC: bar staff cannot take payment for a court booking bill", async () => {
    const bill = await makeBill(10000);
    await expect(recordCounterPayment(w.actors.BAR_STAFF, { billId: bill.id, method: "CASH", amount: 10000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("idempotency key replay → same payment, no duplicate charge", async () => {
    const bill = await makeBill(55000);
    const a = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000 }, "pay-key-1");
    const b = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000 }, "pay-key-1");
    expect(b.paymentId).toBe(a.paymentId);
    expect(await prisma.payment.count({ where: { billId: bill.id } })).toBe(1);
  });

  it("PY-3/PY-7: online payment stays PENDING until server-side verification; duplicate callback → one payment", async () => {
    const bill = await makeBill(55000);
    const start = await startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/done");
    expect(start.gateway).toBe("TEST");
    expect(start.redirectUrl).toMatch(/^\/pay\/test\//);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } });
    expect(p.status).toBe("PENDING");
    expect(await prisma.ledgerEntry.count()).toBe(0);

    const gpid = testGateway.newGatewayPaymentId();
    const payload = { gatewayPaymentId: gpid, outcome: "SUCCESS", signature: testGateway.sign(start.paymentId, gpid, "SUCCESS") };
    const [r1, r2] = await Promise.all([verifyOnlinePayment(start.paymentId, payload), verifyOnlinePayment(start.paymentId, payload)]);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect(await prisma.ledgerEntry.count({ where: { billId: bill.id } })).toBe(1);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.status).toBe("PAID");
    await expectIntegrity();
  });

  it("PY-7: a forged gateway callback is rejected and changes nothing", async () => {
    const bill = await makeBill(55000);
    const start = await startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/done");
    await expect(
      verifyOnlinePayment(start.paymentId, { gatewayPaymentId: "x", outcome: "SUCCESS", signature: "deadbeef" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("PENDING");
  });

  it("PY-7: a FAIL outcome marks the payment FAILED and the bill stays unpaid", async () => {
    const bill = await makeBill(55000);
    const start = await startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/done");
    const gpid = testGateway.newGatewayPaymentId();
    const r = await verifyOnlinePayment(start.paymentId, { gatewayPaymentId: gpid, outcome: "FAIL", signature: testGateway.sign(start.paymentId, gpid, "FAIL") });
    expect(r.status).toBe("FAILED");
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("UNPAID");
  });

  it("online refund goes back through the gateway and the ledger nets to zero", async () => {
    const bill = await makeBill(30000);
    const start = await startOnlinePayment(w.actors.FRONT_DESK, bill.id, "/done");
    const gpid = testGateway.newGatewayPaymentId();
    await verifyOnlinePayment(start.paymentId, { gatewayPaymentId: gpid, outcome: "SUCCESS", signature: testGateway.sign(start.paymentId, gpid, "SUCCESS") });
    const r = await approvedRefund(w, bill.id, 30000, { by: w.actors.OWNER, approver: w.actors.MANAGER, reason: "DUPLICATE_CHARGE", note: "duplicate booking" });
    expect([r.status, r.pending]).toEqual(["COMPLETED", 0]);
    const refund = await prisma.payment.findFirstOrThrow({ where: { billId: bill.id, type: "REFUND" } });
    expect(refund.method).toBe("ONLINE");
    expect(refund.reference).toMatch(/^test_refund_/);
    const sum = await prisma.ledgerEntry.aggregate({ where: { billId: bill.id }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(0);
    await expectIntegrity();
  });
});
