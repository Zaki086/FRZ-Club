// v3 phase 4: the refund workflow (§5.2, RF-1…RF-7) and the drawer screen (§5.1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "@/lib/clock";
import { prisma } from "@/server/db";
import { cancelBooking } from "@/server/services/booking";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { drawerPayments, myDrawer, closeDrawer } from "@/server/services/drawers";
import { testGateway } from "@/server/services/gateway";
import { listView } from "@/server/services/filters";
import { completeRefund, startOnlinePayment, verifyOnlinePayment } from "@/server/services/payments";
import { approveRefund, cancelRefundRequest, payOutRefund, rejectRefund, requestRefund, requestRefundAsMember, retryAtDesk } from "@/server/services/refunds";
import { makeWorld, utr, CARD_PROOF, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});
afterEach(() => {
  vi.restoreAllMocks();
  setCapabilityOverridesForTests({ email: true });
});

/** A court booking for a guest, paid at the desk (₹400 for one walk-in player). */
async function paidBooking(method: "CASH" | "UPI" | "CARD" = "CASH", time = "18:00") {
  const proof = method === "UPI" ? { reference: utr() } : method === "CARD" ? CARD_PROOF : {};
  return book(w, { time, players: [guest("Refund Ravi")], payment: { kind: "COUNTER", method, ...proof } });
}

describe("v3 §5.2 — refund requests", () => {
  it("RF-1: desk, shop, bar, manager and owner ask on bills they can see; the accountant and other staff's bills are refused", async () => {
    const b = await paidBooking();
    await expect(requestRefund(w.actors.BAR_STAFF, { billId: b.billId, amount: 100, reason: "OTHER", note: "not mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestRefund(w.actors.ACCOUNTANT, { billId: b.billId, amount: 100, reason: "OTHER", note: "not allowed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "SERVICE_ISSUE", note: "lights failed for 20 minutes" });
    expect([r.status, r.code]).toEqual(["REQUESTED", expect.stringMatching(/^RF-\d{6}$/)]);
    // v4 §3.3/§4.1: approvers are told with the staff event REFUND_APPROVAL_NEEDED (in-app + push).
    expect(await prisma.notification.count({ where: { type: "REFUND_APPROVAL_NEEDED" } })).toBeGreaterThan(0);
  });

  it("RF-2: amount ≤ what is still refundable (open requests count), partial allowed; a reason category and a note are required", async () => {
    const b = await paidBooking();
    await expect(requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 30000, reason: "GOODWILL", note: "" })).rejects.toThrow();
    await expect(requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 30000, reason: "NICE" as never, note: "x y z" })).rejects.toThrow();
    await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 30000, reason: "GOODWILL", note: "partial" });
    await expect(requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10001, reason: "GOODWILL", note: "too much" })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID", details: { refundable: 10000 } });
    expect((await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "GOODWILL", note: "the rest" })).amount).toBe(10000);
  });

  it("RF-3: policy refunds are created approved; others need a Manager up to ₹5,000 or the Owner above; never your own", async () => {
    // In-time cancellation (BK-7) → an approved, automatic request, paid back from the canceller's drawer.
    const b = await paidBooking("CASH", "20:00");
    await cancelBooking(w.actors.FRONT_DESK, b.bookingId);
    const auto = await prisma.refundRequest.findFirstOrThrow({ where: { billId: b.billId } });
    expect([auto.status, auto.autoApproved, auto.policy, auto.reason]).toEqual(["COMPLETED", true, "BK-7", "POLICY_CANCELLATION"]);

    const big = await makeMember(w, { name: "Gold Gita", plan: "GOLD", months: 12 }); // a large membership bill
    const req = await requestRefund(w.actors.FRONT_DESK, { billId: big.billId!, amount: 600000, reason: "GOODWILL", note: "relocating" });
    await expect(approveRefund(w.actors.MANAGER, req.id)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/above ₹5,000/) });
    await expect(approveRefund(w.actors.FRONT_DESK, req.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await approveRefund(w.actors.OWNER, req.id)).status).toBe("APPROVED");
    const own = await requestRefund(w.actors.MANAGER, { billId: big.billId!, amount: 50000, reason: "GOODWILL", note: "own" });
    await expect(approveRefund(w.actors.MANAGER, own.id)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/your own/) });
    await expect(rejectRefund(w.actors.MANAGER, own.id, "no")).rejects.toThrow();
    await rejectRefund(w.actors.OWNER, own.id, "Not agreed with the member");
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("REJECTED");
    await expect(approveRefund(w.actors.OWNER, own.id)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expectIntegrity();
  });

  it("RF-4: the money goes back the way it came — UPI needs the outgoing UTR, card the reversal reference, cash an open drawer", async () => {
    const upi = await paidBooking("UPI", "11:00");
    const r1 = await requestRefund(w.actors.FRONT_DESK, { billId: upi.billId, amount: 40000, reason: "SERVICE_ISSUE", note: "court closed" });
    expect((await approveRefund(w.actors.MANAGER, r1.id)).status).toBe("APPROVED"); // ready to pay out at the desk
    // v4 RF-9: every pay-out needs the identity tick; a guest also gives the original booking code.
    const guestId1 = { identityChecked: true, originalCode: upi.bookingCode };
    await expect(payOutRefund(w.actors.FRONT_DESK, r1.id, { method: "UPI", ...guestId1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const done = await payOutRefund(w.actors.FRONT_DESK, r1.id, { method: "UPI", reference: utr(), ...guestId1 });
    expect([done.status, done.payments.map((p) => [p.method, p.status])]).toEqual(["COMPLETED", [["UPI", "SUCCEEDED"]]]);

    const card = await paidBooking("CARD", "12:00");
    const r2 = await requestRefund(w.actors.FRONT_DESK, { billId: card.billId, amount: 40000, reason: "DUPLICATE_CHARGE", note: "charged twice" });
    await approveRefund(w.actors.MANAGER, r2.id);
    await expect(payOutRefund(w.actors.FRONT_DESK, r2.id, { method: "CARD", identityChecked: true, originalCode: card.bookingCode })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await payOutRefund(w.actors.FRONT_DESK, r2.id, { method: "CARD", approvalCode: "REV001", identityChecked: true, originalCode: card.bookingCode })).status).toBe("COMPLETED");

    const cash = await paidBooking("CASH", "13:00");
    const r3 = await requestRefund(w.actors.FRONT_DESK, { billId: cash.billId, amount: 40000, reason: "GOODWILL", note: "regular" });
    await approveRefund(w.actors.MANAGER, r3.id);
    await closeDrawer(w.actors.SHOP_STAFF, { cashCounted: 0 }); // the shop has no drawer open now
    await expect(payOutRefund(w.actors.SHOP_STAFF, r3.id, { method: "CASH", identityChecked: true, originalCode: cash.bookingCode })).rejects.toMatchObject({ code: "FORBIDDEN" }); // and can't pay a court bill anyway
    const before = (await myDrawer(w.actors.FRONT_DESK)).open!.cashExpected;
    await payOutRefund(w.actors.FRONT_DESK, r3.id, { method: "CASH", identityChecked: true, originalCode: cash.bookingCode });
    expect((await myDrawer(w.actors.FRONT_DESK)).open!.cashExpected).toBe(before - 40000);
    await expectIntegrity();
  });

  it("RF-4: online money goes back through the gateway on approval; with online payments off it waits at the desk; a gateway failure is FAILED and can be paid at the desk", async () => {
    async function onlineBill(time: string) {
      const b = await book(w, { time, players: [guest("Online Olu")], payment: { kind: "LATER" } });
      const s = await startOnlinePayment(w.actors.FRONT_DESK, b.billId, "/x");
      const gp = testGateway.newGatewayPaymentId();
      await verifyOnlinePayment(s.paymentId, { gatewayPaymentId: gp, outcome: "SUCCESS", signature: testGateway.sign(s.paymentId, gp, "SUCCESS") });
      return b;
    }
    const a = await onlineBill("14:00");
    const ra = await requestRefund(w.actors.FRONT_DESK, { billId: a.billId, amount: 40000, reason: "SERVICE_ISSUE", note: "rain" });
    const da = await approveRefund(w.actors.MANAGER, ra.id);
    expect([da.status, da.payments[0].method, da.payments[0].reference]).toEqual(["COMPLETED", "ONLINE", expect.stringMatching(/^test_refund_/)]);

    const b = await onlineBill("15:00");
    const rb = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 40000, reason: "SERVICE_ISSUE", note: "rain" });
    vi.spyOn(testGateway, "refund").mockRejectedValueOnce(new Error("bank unavailable"));
    const db = await approveRefund(w.actors.MANAGER, rb.id);
    expect([db.status, db.failureReason]).toEqual(["FAILED", expect.stringMatching(/bank unavailable/)]);
    expect(await prisma.payment.count({ where: { refundRequestId: rb.id } })).toBe(0);
    const again = await retryAtDesk(w.actors.MANAGER, rb.id);
    await paidBooking("CASH", "17:00"); // v4 RF-9: cash is paid out only from cash in the drawer (this was paid online)
    expect((await payOutRefund(w.actors.FRONT_DESK, again.id, { method: "CASH", identityChecked: true, originalCode: b.bookingCode })).status).toBe("COMPLETED");

    const c = await onlineBill("16:00");
    setCapabilityOverridesForTests({ "payments.online": false, email: true });
    const rc = await requestRefund(w.actors.FRONT_DESK, { billId: c.billId, amount: 40000, reason: "SERVICE_ISSUE", note: "rain" });
    expect((await approveRefund(w.actors.MANAGER, rc.id)).status).toBe("APPROVED");
    expect((await listView(w.actors.FRONT_DESK, "refunds", { status: "APPROVED" })).rows.map((r) => r.code)).toContain(rc.code);
    await expectIntegrity();
  });

  it("RF-5: completion writes the REFUND payment and the negative ledger entry together and tells the member", async () => {
    const m = await makeMember(w, { name: "Notify Nia", plan: "SILVER" });
    const req = await requestRefund(w.actors.FRONT_DESK, { billId: m.billId!, amount: 50000, reason: "GOODWILL", note: "injury" });
    await approveRefund(w.actors.MANAGER, req.id);
    expect(await prisma.ledgerEntry.count({ where: { billId: m.billId!, amount: { lt: 0 } } })).toBe(0); // nothing moves before pay-out
    await payOutRefund(w.actors.FRONT_DESK, req.id, { method: "UPI", reference: utr(), identityChecked: true });
    const neg = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId: m.billId!, amount: { lt: 0 } } });
    const pay = await prisma.payment.findFirstOrThrow({ where: { refundRequestId: req.id } });
    expect([neg.amount, neg.paymentId, pay.status]).toEqual([-50000, pay.id, "SUCCEEDED"]);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: m.member.userId!, type: "REFUND_COMPLETED" } });
    expect(note.title).toBe("Refund of ₹500 completed");
    await expectIntegrity();
  });

  it("RF-1 (members): only eligible items, from their own bills; (v4 §3.2) the request waits for approval, then is collected at the desk", async () => {
    const m = await makeMember(w, { name: "Portal Pia", plan: "SILVER" });
    const other = await makeMember(w, { name: "Other Omar", plan: "SILVER" });
    // The member books for themselves and a guest; the guest's ₹400 is on the member's bill.
    const b = await book(w, { time: "19:00", players: [{ memberId: m.memberId }, guest("Friend Fia")], payment: { kind: "COUNTER", method: "CASH" } });
    expect(b.total).toBeGreaterThan(0);
    await expect(requestRefundAsMember(m.actor, { billId: m.billId! })).rejects.toMatchObject({ code: "REFUND_NOT_ELIGIBLE" }); // a membership isn't
    await expect(requestRefundAsMember(other.actor, { billId: b.billId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestRefundAsMember(m.actor, { billId: b.billId })).rejects.toMatchObject({ code: "REFUND_NOT_ELIGIBLE" }); // still on
    // A booking cancelled within policy whose money was not returned (e.g. recorded before this workflow).
    await prisma.booking.update({ where: { id: b.bookingId }, data: { status: "CANCELLED", cancelledAt: clock.now() } });
    const r = await requestRefundAsMember(m.actor, { billId: b.billId, note: "please refund" });
    // v4 §3.2/§3.6: a member's request waits for a manager (approvers are told), then is ready to collect at the desk.
    expect([r.status, r.amount]).toEqual(["REQUESTED", b.total]);
    await expect(requestRefundAsMember(m.actor, { billId: b.billId })).rejects.toMatchObject({ code: "REFUND_NOT_ELIGIBLE" }); // nothing left
    expect((await approveRefund(w.actors.MANAGER, r.id)).collectStatus).toBe("READY_TO_COLLECT");
    await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true });
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("COMPLETED");
  });

  it("RF-6: the queue's summary strip counts awaiting approval, ready to pay out and completed today; bar staff see only bar refunds", async () => {
    const a = await paidBooking("CASH", "11:00");
    const b = await paidBooking("CASH", "12:00");
    const ra = await requestRefund(w.actors.FRONT_DESK, { billId: a.billId, amount: 10000, reason: "GOODWILL", note: "first" });
    const rb = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 20000, reason: "GOODWILL", note: "second" });
    await approveRefund(w.actors.MANAGER, rb.id);
    const rc = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 5000, reason: "GOODWILL", note: "third" });
    await approveRefund(w.actors.MANAGER, rc.id);
    await payOutRefund(w.actors.FRONT_DESK, rc.id, { method: "CASH", identityChecked: true, originalCode: b.bookingCode });
    const r = await listView(w.actors.MANAGER, "refunds", {});
    const s = Object.fromEntries(r.summary.map((x) => [x.key, x.value]));
    expect([s.awaiting, s.ready, s.today]).toEqual([1, 1, 5000]);
    expect(r.rows[0].code).toBe(ra.code); // "to do first": awaiting approval on top
    expect((await listView(w.actors.BAR_STAFF, "refunds", {})).total).toBe(0);
    await cancelRefundRequest(w.actors.FRONT_DESK, ra.id);
    await expect(cancelRefundRequest(w.actors.SHOP_STAFF, rb.id)).rejects.toThrow();
  });

  it("RF-7: every transition is audited with the actor; pay-outs through the old pending list complete the request too", async () => {
    const b = await paidBooking("UPI", "11:00");
    const req = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 40000, reason: "GOODWILL", note: "regular player" });
    await approveRefund(w.actors.MANAGER, req.id, "fine");
    const pending = await prisma.payment.findFirstOrThrow({ where: { refundRequestId: req.id, status: "PENDING" } });
    await completeRefund(w.actors.FRONT_DESK, pending.id, { method: "UPI", reference: utr() });
    const log = await prisma.auditLog.findMany({ where: { entity: "refund_request", entityId: req.id }, orderBy: { at: "asc" } });
    expect(log.map((l) => [l.action, l.actorId])).toEqual([
      ["refund_request.requested", w.actors.FRONT_DESK.userId],
      ["refund_request.approved", w.actors.MANAGER.userId],
      ["refund_request.ready_to_collect", w.actors.MANAGER.userId], // v4 RF-8: waiting at the desk is a transition too
      ["refund_request.completed", w.actors.FRONT_DESK.userId],
    ]);
    await expectIntegrity();
  });
});

describe("v3 §5.1 — the drawer shows every method collected; only cash is counted", () => {
  it("collections by method with counts; expected cash = float + cash − cash refunds; each method's drill-down sums exactly", async () => {
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 0 });
    const { openDrawer } = await import("@/server/services/drawers");
    await openDrawer(w.actors.FRONT_DESK, { area: "DESK", openingFloat: 100000 });
    await paidBooking("CASH", "11:00");
    await paidBooking("CASH", "12:00");
    await paidBooking("UPI", "13:00");
    await paidBooking("CARD", "14:00");
    const later = await book(w, { time: "15:00", players: [guest("Online Ola")], payment: { kind: "LATER" } });
    const s = await startOnlinePayment(w.actors.FRONT_DESK, later.billId, "/x");
    const gp = testGateway.newGatewayPaymentId();
    await verifyOnlinePayment(s.paymentId, { gatewayPaymentId: gp, outcome: "SUCCESS", signature: testGateway.sign(s.paymentId, gp, "SUCCESS") });
    const d = (await myDrawer(w.actors.FRONT_DESK)).open!;
    const by = Object.fromEntries(d.collections.map((c) => [c.method, [c.count, c.amount]]));
    expect(by).toEqual({ CASH: [2, 80000], UPI: [1, 40000], CARD: [1, 40000], ONLINE: [1, 40000] });
    expect([d.totalCollected, d.cashExpected]).toEqual([200000, 180000]);
    for (const m of ["CASH", "UPI", "CARD", "ONLINE"]) {
      const dd = await drawerPayments(w.actors.FRONT_DESK, d.id, m);
      expect(dd.payments.reduce((a, p) => a + p.amount, 0)).toBe(by[m][1]);
      expect(dd.total).toBe(by[m][1]);
    }
    await expect(drawerPayments(w.actors.BAR_STAFF, d.id, "CASH")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await drawerPayments(w.actors.MANAGER, d.id, "CASH")).payments).toHaveLength(2);
    const r = await listView(w.actors.MANAGER, "drawers", { state: "OPEN", q: "Farah" });
    expect(r.rows.map((x) => [x.cash_in, x.upi, x.card, x.online, x.cash_expected])).toEqual([[80000, 40000, 40000, 40000, 180000]]);
    const closed = await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 179000 });
    expect(closed.variance).toBe(-1000);
    expect((await listView(w.actors.ACCOUNTANT, "drawers", { variance: "yes" })).total).toBe(1);
  });
});
