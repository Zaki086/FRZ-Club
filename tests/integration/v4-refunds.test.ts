// v4 §3 Refunds v2: cash refunds are collected at the desk (RF-8, RF-9), never forgotten (RF-10), partial per bill
// (RF-11), member-facing (portal Refunds + Payments, guardians), and every step reaches the member (§3.6).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { memberCardPayload } from "@/lib/qr";
import { DAY } from "@/lib/time";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { SYSTEM } from "@/server/rbac/actor";
import { createMember } from "@/server/services/membership";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { drawerBalanceTx } from "@/server/services/drawers";
import { listView } from "@/server/services/filters";
import { getBill, startOnlinePayment, verifyOnlinePayment } from "@/server/services/payments";
import { testGateway } from "@/server/services/gateway";
import { dashboard } from "@/server/services/reports";
import { refundCollectToken, verifyRefundCollectToken } from "@/server/services/refund-qr";
import {
  approveRefund, findCollectableRefunds, getRefundRequest, myPayments, myRefunds, payOutRefund, publicRefundByToken, refundReceipt, refundsPayableSummary,
  rejectRefund, requestRefund, requestRefundAsMember, runRefundReminders,
} from "@/server/services/refunds";
import { writeSettingTx } from "@/server/services/settings";
import { setWhatsAppFetchForTests } from "@/server/services/whatsapp/client";
import { runDailyJobs } from "@/server/jobs";
import { makeWorld, T0, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026 10:00 IST, every staff drawer open with a ₹0 float
});
afterEach(async () => {
  await settleAfterCommit();
  setWhatsAppFetchForTests(null);
  setCapabilityOverridesForTests({ email: true });
});

const fdDrawer = async () => (await prisma.cashDrawerSession.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId, closedAt: null } })).id;

/** A member's court booking (with a guest on the bill), paid in cash at the front desk: ₹550 in the desk drawer. */
async function memberBooking(name: string, time = "18:00") {
  const m = await makeMember(w, { name, plan: "SILVER" });
  const b = await book(w, { time, players: [{ memberId: m.memberId }, guest(`Pal of ${name}`)], payment: { kind: "COUNTER", method: "CASH" } });
  return { m, b };
}

/** Ask (the desk) and approve (the Manager): in cash-only mode it waits at the desk. */
async function readyRefund(billId: string, amount: number) {
  const req = await requestRefund(w.actors.FRONT_DESK, { billId, amount, reason: "SERVICE_ISSUE", note: "lights failed" });
  return approveRefund(w.actors.MANAGER, req.id);
}

/** WhatsApp Cloud API set up with every refund template approved, the member opted in, Meta mocked. */
async function whatsappOn(memberIds: string[]) {
  setCapabilityOverridesForTests({ email: true, "whatsapp.api": true });
  const t = (name: string) => ({ name, language: "en", status: "APPROVED", checked_at: null });
  await withTx((tx) =>
    writeSettingTx(tx, SYSTEM, "whatsapp_template_map", {
      refund_ready_to_collect: t("refund_ready_to_collect"), refund_completed: t("refund_completed"),
      refund_rejected: t("refund_rejected"), refund_unclaimed_reminder: t("refund_unclaimed_reminder"),
    }),
  );
  await prisma.member.updateMany({ where: { id: { in: memberIds } }, data: { whatsappOptInAt: clock.now() } });
  let n = 0;
  setWhatsAppFetchForTests(async () => new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.T${++n}` }] }), { status: 200, headers: { "content-type": "application/json" } }));
}

async function waRow(memberId: string, event: string) {
  const d = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId, event, channel: "WHATSAPP_API" } });
  return { template: d.waTemplate, params: d.waParams, button: d.waButtonParam, status: d.status };
}

describe("v4 §3.1 — RF-8 cash refunds are collected at the desk", () => {
  it("RF-8: an approved cash refund becomes READY_TO_COLLECT (still APPROVED) with its code and a signed collection QR; the member is told amount, code, desk hours and QR link", async () => {
    const { m, b } = await memberBooking("Ready Rina");
    const r = await readyRefund(b.billId, 15000);
    expect([r.status, r.collectStatus, r.code]).toEqual(["APPROVED", "READY_TO_COLLECT", expect.stringMatching(/^RF-\d{6}$/)]);
    expect(r.readyAt?.getTime()).toBe(clock.now().getTime());
    expect(r.payments.map((p) => [p.method, p.status, p.amount])).toEqual([["CASH", "PENDING", 15000]]);
    const token = refundCollectToken(r.id);
    expect(token).toMatch(new RegExp(`^RF1\\.${r.id}\\.[A-Za-z0-9_-]{32}$`));
    const note = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "REFUND_READY_TO_COLLECT", channel: "IN_APP" } });
    expect(note.title).toBe("Refund of ₹150 ready to collect");
    expect(note.body).toMatch(new RegExp(`^${r.code} · ₹150 for your court booking ${b.bookingCode} \\(Court 1, .*\\) is ready in cash at the front desk \\(open 06:00–22:00\\)\\. .*\\/rq\\/${token.replace(/\./g, "\\.")}`));
    expect(note.link).toBe(`/portal/refunds?ref=${r.code}`);
    expect(await prisma.notificationDelivery.count({ where: { memberId: m.memberId, event: "REFUND_APPROVED" } })).toBe(0);
    // The v3 state machine is unchanged: the list still shows it as approved / ready to pay out.
    expect((await listView(w.actors.FRONT_DESK, "refunds", { status: "APPROVED" })).rows.map((x) => [x.code, x.collect_status])).toEqual([[r.code, "READY_TO_COLLECT"]]);
    await expectIntegrity();
  });

  it("RF-8: with online payments on, online money still goes straight back through the gateway (never READY_TO_COLLECT)", async () => {
    const m = await makeMember(w, { name: "Online Oona", plan: "SILVER" });
    const b = await book(w, { time: "19:00", players: [{ memberId: m.memberId }], payment: { kind: "LATER" } });
    const s = await startOnlinePayment(w.actors.FRONT_DESK, b.billId, "/x");
    const gp = testGateway.newGatewayPaymentId();
    await verifyOnlinePayment(s.paymentId, { gatewayPaymentId: gp, outcome: "SUCCESS", signature: testGateway.sign(s.paymentId, gp, "SUCCESS") });
    const r = await readyRefund(b.billId, 10000);
    expect([r.status, r.collectStatus, r.payments[0].method]).toEqual(["COMPLETED", null, "ONLINE"]);
    expect(await prisma.notificationDelivery.count({ where: { memberId: m.memberId, event: { in: ["REFUND_READY_TO_COLLECT", "REFUND_COLLECTED"] } } })).toBe(0);
  });

  it("RF-8: the collection QR is HMAC-signed — valid verifies, forged / altered / other prefixes are refused (constant-time); /rq shows code, amount and first name only", async () => {
    const { b } = await memberBooking("Qr Quinn Kapoor");
    const r = await readyRefund(b.billId, 15000);
    const token = refundCollectToken(r.id);
    expect(verifyRefundCollectToken(token)).toBe(r.id);
    expect(verifyRefundCollectToken(encodeURIComponent(token))).toBe(r.id);
    const [p, id, mac] = token.split(".");
    expect(verifyRefundCollectToken(`${p}.${id}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`)).toBeNull(); // forged mac
    expect(verifyRefundCollectToken(`${p}.${id}x.${mac}`)).toBeNull(); // another refund id with this mac
    expect(verifyRefundCollectToken(`CC1.${id}.${mac}`)).toBeNull(); // not a refund QR
    expect(verifyRefundCollectToken(`${p}.${id}.${mac}.extra`)).toBeNull();
    expect(verifyRefundCollectToken("%E0%A4%A")).toBeNull();
    await expect(findCollectableRefunds(w.actors.FRONT_DESK, `${p}.${id}.${"A".repeat(32)}`)).rejects.toMatchObject({ code: "INVALID_REFUND_QR" });
    await expect(publicRefundByToken(`${p}.${id}.${"A".repeat(32)}`)).rejects.toMatchObject({ code: "INVALID_REFUND_QR" });
    const view = await publicRefundByToken(token);
    expect(view).toEqual({ code: r.code, firstName: "Qr", amount: 15000, state: "READY", readyAt: r.readyAt, completedAt: null, token });
    expect(JSON.stringify(view)).not.toMatch(/Kapoor|Quinn|\d{10}/);
  });
});

describe("v4 §3.1 — RF-9 paying out at the desk", () => {
  it("RF-9: payout is blocked without the identity tick; with it, one transaction pays from the open drawer (balance decrements), writes the negative ledger entry and completes it as COLLECTED", async () => {
    const { m, b } = await memberBooking("Collect Chandni");
    const r = await readyRefund(b.billId, 15000);
    const drawer = await fdDrawer();
    const before = await drawerBalanceTx(prisma, drawer);
    expect(before).toBeGreaterThanOrEqual(55000); // the booking was paid in cash into this drawer
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH" })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED" });
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: false })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED" });
    // Nothing moved.
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED");
    expect(await prisma.ledgerEntry.count({ where: { billId: b.billId, amount: { lt: 0 } } })).toBe(0);
    expect(await drawerBalanceTx(prisma, drawer)).toBe(before);

    // Found by the refund QR, the member card or a search — with the member photo slot and what is waiting.
    const byQr = await findCollectableRefunds(w.actors.FRONT_DESK, refundCollectToken(r.id));
    expect([byQr.via, byQr.refunds.map((x) => [x.code, x.toCollect, x.member?.name, x.member?.memberCode])]).toEqual(["REFUND_QR", [[r.code, 15000, "Collect Chandni", m.member.memberCode]]]);
    expect((await findCollectableRefunds(w.actors.FRONT_DESK, memberCardPayload(m.memberId))).refunds.map((x) => x.id)).toEqual([r.id]);
    for (const q of [r.code, "chandni", m.member.phone, b.bookingCode]) expect((await findCollectableRefunds(w.actors.FRONT_DESK, q)).refunds.map((x) => x.id)).toEqual([r.id]);
    expect((await findCollectableRefunds(w.actors.BAR_STAFF, r.code)).refunds).toEqual([]); // not a bar bill

    const done = await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true, via: "REFUND_QR" });
    expect([done.status, done.collectStatus, done.identityMethod, done.identityCheckedBy]).toEqual(["COMPLETED", "COLLECTED", "REFUND_QR", w.actors.FRONT_DESK.userId]);
    expect(await drawerBalanceTx(prisma, drawer)).toBe(before - 15000);
    const neg = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId: b.billId, amount: { lt: 0 } } });
    const pay = await prisma.payment.findFirstOrThrow({ where: { refundRequestId: r.id } });
    expect([neg.amount, neg.paymentId, pay.status, pay.drawerSessionId]).toEqual([-15000, pay.id, "SUCCEEDED", drawer]);
    expect(done.paidOut).toEqual([expect.objectContaining({ method: "CASH", amount: 15000, by: w.actors.FRONT_DESK.name, where: "front desk" })]);
    // The member hears "collected", with the receipt.
    const col = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "REFUND_COLLECTED", channel: "IN_APP" } });
    expect([col.title, col.link]).toEqual(["Refund of ₹150 collected", `/portal/refunds/${r.id}/receipt`]);
    // 80 mm receipt: refund code, amount, original bill, staff, time.
    const rc = await refundReceipt(w.actors.FRONT_DESK, r.id);
    expect([rc.code, rc.amount, rc.original.code, rc.original.total, rc.paidOut[0].by, rc.completedAt?.getTime(), rc.identityCheckedBy]).toEqual([r.code, 15000, b.bookingCode, 55000, w.actors.FRONT_DESK.name, clock.now().getTime(), w.actors.FRONT_DESK.name]);
    await expect(refundReceipt(m.actor, r.id)).resolves.toMatchObject({ code: r.code });
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expectIntegrity();
  });

  it("RF-9: guests are identified by phone + the original booking code; a wrong one is refused", async () => {
    const b = await book(w, { time: "18:00", players: [{ guest: { name: "Guest Gauri", phone: "9876501234" } }], payment: { kind: "COUNTER", method: "CASH" } });
    const r = await readyRefund(b.billId, 10000);
    const found = await findCollectableRefunds(w.actors.FRONT_DESK, "98765 01234");
    expect(found.refunds.map((x) => [x.id, x.member, x.guest])).toEqual([[r.id, null, { needsPhone: true, needsCode: true, codeLabel: "court booking code" }]]);
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED", details: { needs: "originalCode" } });
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true, originalCode: "BK-999999", guestPhone: "9876501234" })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED" });
    await expect(payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true, originalCode: b.bookingCode, guestPhone: "9000000000" })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED", details: { needs: "guestPhone" } });
    const done = await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true, originalCode: b.bookingCode.toLowerCase(), guestPhone: "+91 98765 01234" });
    expect([done.status, done.identityMethod]).toEqual(["COMPLETED", "GUEST_PHONE_CODE"]);
  });

  it("RF-9: a drawer that can't cover the refund refuses it (INSUFFICIENT_CASH_IN_DRAWER) and nothing is paid; once the cash is in the drawer it goes through", async () => {
    // A membership paid by UPI: no cash came into any drawer for it.
    const m = await makeMember(w, { name: "Short Shreya", plan: "SILVER" });
    const r = await readyRefund(m.billId!, 50000);
    const drawer = await fdDrawer();
    const before = await drawerBalanceTx(prisma, drawer);
    expect(before).toBeLessThan(50000);
    const err = await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INSUFFICIENT_CASH_IN_DRAWER" });
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED");
    expect(await prisma.payment.count({ where: { refundRequestId: r.id, status: "SUCCEEDED" } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { billId: m.billId!, amount: { lt: 0 } } })).toBe(0);
    expect(await drawerBalanceTx(prisma, drawer)).toBe(before);
    // Cash comes in at the desk (a booking paid in cash), then the same pay-out goes through and the drawer gives it.
    await book(w, { time: "18:00", players: [guest("Cash Chirag"), guest("Cash Chitra")], payment: { kind: "COUNTER", method: "CASH" } });
    const withCash = await drawerBalanceTx(prisma, drawer);
    expect(withCash).toBeGreaterThanOrEqual(50000);
    expect((await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true })).status).toBe("COMPLETED");
    expect(await drawerBalanceTx(prisma, drawer)).toBe(withCash - 50000);
    await expectIntegrity();
  });
});

describe("v4 §3.1 — RF-10 unclaimed refunds", () => {
  it("RF-10: reminders at 3 and 7 days, then every 14 days, at most 4 — each once; a missed day sends only the latest; collected refunds get none", async () => {
    const { m, b } = await memberBooking("Remind Ravi");
    const r = await readyRefund(b.billId, 15000);
    const { b: b2 } = await memberBooking("Collected Kiran", "19:00");
    const r2 = await readyRefund(b2.billId, 15000);
    await payOutRefund(w.actors.FRONT_DESK, r2.id, { method: "CASH", identityChecked: true });
    const at = (d: number) => new Date(T0.getTime() + d * DAY);
    const sent: number[] = [];
    for (const d of [1, 2.9, 3, 3.5, 6, 7, 8, 20, 21, 34, 35, 49, 63, 120]) sent.push((await runRefundReminders(at(d))).reminded);
    expect(sent).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0]);
    const rows = await prisma.notificationDelivery.findMany({ where: { memberId: m.memberId, event: "REFUND_UNCLAIMED_REMINDER", channel: "IN_APP" }, orderBy: { dedupeKey: "asc" } });
    expect(rows.map((x) => x.dedupeKey)).toEqual([1, 2, 3, 4].map((n) => `refund-unclaimed:${r.id}:${n}`));
    expect(rows[0].body).toMatch(new RegExp(`${r.code} · ₹150 .* has been ready at the front desk since 12 Oct 2026\\. Collect it any day 06:00–22:00`));
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).remindersSent).toBe(4);
    // Still a liability: never expires.
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).collectStatus).toBe("READY_TO_COLLECT");

    // A job that missed days: only the latest reminder due goes out.
    const { b: b3 } = await memberBooking("Late Lalit", "20:00");
    clock.set(T0);
    const r3 = await readyRefund(b3.billId, 15000);
    expect((await runRefundReminders(at(22))).reminded).toBe(1);
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: r3.id } })).remindersSent).toBe(3);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: { startsWith: `refund-unclaimed:${r3.id}` }, channel: "IN_APP" } })).toBe(1);
    clock.set(at(36));
    expect((await runDailyJobs()).refundReminders).toEqual({ reminded: 1 });
  });

  it("RF-10: unclaimed refunds show in the Owner's What we owe as Refunds payable (count, amount, oldest)", async () => {
    const { b } = await memberBooking("Owe Omkar");
    await readyRefund(b.billId, 15000);
    const { b: b2 } = await memberBooking("Owe Uma", "19:00");
    clock.set(new Date(T0.getTime() + 2 * DAY));
    await readyRefund(b2.billId, 20000);
    clock.set(new Date(T0.getTime() + 5 * DAY));
    expect(await refundsPayableSummary()).toEqual({ count: 2, amountPaise: 35000, oldestDays: 5 });
    const d = await dashboard(w.actors.OWNER, { period: "TODAY" });
    const pay = (d as { payables: { total: number; refunds: number; refundCount: number; refundOldestDays: number | null; expenses: number; payroll: number; gst: number } }).payables;
    expect([pay.refunds, pay.refundCount, pay.refundOldestDays]).toEqual([35000, 2, 5]);
    expect(pay.total).toBe(pay.expenses + pay.payroll + pay.gst + 35000);
    const strip = Object.fromEntries((await listView(w.actors.FRONT_DESK, "refunds", { status: "COMPLETED" })).summary.map((s) => [s.key, s.value]));
    expect([strip.ready, strip.ready_amount, strip.awaiting, strip.oldest]).toEqual([2, 35000, 0, 5]); // the same on every tab
  });
});

describe("v4 §3.1 — RF-11 partial refunds", () => {
  it("RF-11: several refunds on one bill; what is left is shown wherever a refund can be asked for, and never exceeded", async () => {
    const { m, b } = await memberBooking("Part Pooja");
    const r1 = await readyRefund(b.billId, 10000);
    expect((await getBill(w.actors.FRONT_DESK, b.billId)).refundable).toBe(45000);
    const r2 = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 20000, reason: "GOODWILL", note: "second part" });
    expect((await getBill(w.actors.FRONT_DESK, b.billId)).refundable).toBe(25000);
    expect((await getRefundRequest(w.actors.FRONT_DESK, r2.id)).refundableLeft).toBe(25000);
    await expect(requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 25001, reason: "GOODWILL", note: "too much" })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID", details: { refundable: 25000 } });
    await approveRefund(w.actors.MANAGER, r2.id);
    await payOutRefund(w.actors.FRONT_DESK, r1.id, { method: "CASH", identityChecked: true });
    await payOutRefund(w.actors.FRONT_DESK, r2.id, { method: "CASH", identityChecked: true, via: "MEMBER_CARD" });
    const bill = await getBill(w.actors.FRONT_DESK, b.billId);
    expect([bill.amountRefunded, bill.refundable, bill.status]).toEqual([30000, 25000, "PARTIALLY_REFUNDED"]);
    // Members: an eligible item shows what is left; they may ask for part of it.
    await prisma.booking.update({ where: { id: b.bookingId }, data: { status: "CANCELLED", cancelledAt: clock.now() } });
    expect((await myRefunds(m.actor)).eligible.map((e) => [e.billId, e.refundable, e.paid])).toEqual([[b.billId, 25000, 25000]]);
    await expect(requestRefundAsMember(m.actor, { billId: b.billId, amount: 25001 })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
    const part = await requestRefundAsMember(m.actor, { billId: b.billId, amount: 5000, note: "half of what's left" });
    expect([part.status, part.amount]).toEqual(["REQUESTED", 5000]);
    expect((await myRefunds(m.actor)).eligible.map((e) => e.refundable)).toEqual([20000]);
    await expectIntegrity();
  });
});

describe("v4 §3.2–§3.6 — members", () => {
  it("§3.7: member request → approvers told (push, deep link) → manager approves → member sees Ready to collect → collected at the desk; the portal lists the full history", async () => {
    setCapabilityOverridesForTests({ email: true, push: true });
    const { m, b } = await memberBooking("Asks Anaya");
    await prisma.booking.update({ where: { id: b.bookingId }, data: { status: "CANCELLED", cancelledAt: clock.now() } }); // cancelled in time, money not yet returned
    const req = await requestRefundAsMember(m.actor, { billId: b.billId, note: "I cancelled the day before" });
    expect([req.status, req.amount]).toEqual(["REQUESTED", 55000]);
    const row = await prisma.refundRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect([row.requestedVia, row.reason, row.policy, row.autoApproved]).toEqual(["MEMBER", "POLICY_CANCELLATION", "BK-7", false]);
    // Member: confirmation. Approvers (Manager + Owner): in-app + push with a link to the refund.
    expect(await prisma.notificationDelivery.count({ where: { memberId: m.memberId, event: "REFUND_REQUESTED", channel: "IN_APP" } })).toBe(1);
    const appr = await prisma.notificationDelivery.findMany({ where: { event: "REFUND_APPROVAL_NEEDED" }, orderBy: { channel: "asc" } });
    expect(new Set(appr.map((d) => d.userId))).toEqual(new Set([w.actors.MANAGER.userId, w.actors.OWNER.userId]));
    expect([...new Set(appr.map((d) => d.channel))].sort()).toEqual(["IN_APP", "PUSH"]);
    expect(appr.every((d) => d.link === `/app/refunds/${req.id}`)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: w.actors.MANAGER.userId, type: "REFUND_APPROVAL_NEEDED", link: `/app/refunds/${req.id}` } })).toBe(1);
    // "Requested by members" on the desk page.
    expect((await listView(w.actors.FRONT_DESK, "refunds", { via: "MEMBER" })).rows.map((x) => x.code)).toEqual([req.code]);
    await expect(approveRefund(m.actor, req.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approveRefund(w.actors.MANAGER, req.id);
    const mine = await myRefunds(m.actor);
    expect(mine.ready).toEqual({ count: 1, amount: 55000 });
    expect(mine.refunds[0]).toMatchObject({ code: req.code, status: "APPROVED", collectStatus: "READY_TO_COLLECT", approvedBy: w.actors.MANAGER.name, token: refundCollectToken(req.id) });
    await payOutRefund(w.actors.FRONT_DESK, req.id, { method: "CASH", identityChecked: true, via: "MEMBER_CARD" });
    // A second, rejected request on another bill: the history keeps it with the reason.
    const b2 = await book(w, { time: "20:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const no = await requestRefund(w.actors.FRONT_DESK, { billId: b2.billId, amount: 5000, reason: "GOODWILL", note: "asked at the desk" });
    await rejectRefund(w.actors.MANAGER, no.id, "Session was played in full");
    const hist = await myRefunds(m.actor);
    expect(hist.refunds.map((x) => [x.code, x.status, x.collectStatus])).toEqual([[no.code, "REJECTED", null], [req.code, "COMPLETED", "COLLECTED"]]);
    const done = hist.refunds[1];
    expect(done).toMatchObject({ requestedVia: "MEMBER", approvedBy: w.actors.MANAGER.name, paidOut: [expect.objectContaining({ method: "cash", amount: 55000, where: "front desk" })], token: null });
    expect([done.requestedAt, done.decidedAt, done.readyAt, done.completedAt].every(Boolean)).toBe(true);
    expect(hist.refunds[0].decisionNote).toBe("Session was played in full");
    // Payments tab: payments and refunds with running totals and receipt links.
    const pays = await myPayments(m.actor);
    const billIds = (await prisma.bill.findMany({ where: { memberId: m.memberId }, select: { id: true } })).map((x) => x.id);
    const paidIn = (await prisma.payment.aggregate({ where: { billId: { in: billIds }, type: "PAYMENT", status: "SUCCEEDED" }, _sum: { amount: true } }))._sum.amount ?? 0;
    expect(paidIn).toBe(55000 + b2.total + (await prisma.bill.findUniqueOrThrow({ where: { id: m.billId! } })).amountPaid);
    expect(pays.totals).toEqual({ paid: paidIn, refunded: 55000, net: paidIn - 55000 });
    const refundRow = pays.rows.find((x) => x.type === "REFUND")!;
    expect([refundRow.refundCode, refundRow.receipt, refundRow.status]).toEqual([req.code, `/portal/refunds/${req.id}/receipt`, "SUCCEEDED"]);
    expect(pays.rows[0].runningNet).toBe(pays.totals.net);
    await expectIntegrity();
  });

  it("§3.4: a guardian sees (and may ask for) their linked Junior's refunds; other members see nothing", async () => {
    const parent = await makeMember(w, { name: "Parent Prachi", plan: "SILVER" });
    const other = await makeMember(w, { name: "Other Ojas", plan: "SILVER" });
    const kid = await createMember(w.actors.FRONT_DESK, { name: "Junior Jai", phone: "9811100777", dob: "2013-03-03", guardianName: "Parent Prachi", guardianPhone: parent.member.phone, plan: { code: "JUNIOR", months: 1, payment: { method: "CASH" } } });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: kid.memberId } })).guardianMemberId).toBe(parent.memberId);
    const b = await book(w, { time: "17:00", players: [{ memberId: kid.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const r = await readyRefund(b.billId, b.total);
    const seen = await myRefunds(parent.actor);
    expect(seen.refunds.map((x) => [x.code, x.forName, x.collectStatus])).toEqual([[r.code, "Junior Jai", "READY_TO_COLLECT"]]);
    expect(seen.ready.count).toBe(1);
    await expect(getRefundRequest(parent.actor, r.id)).resolves.toMatchObject({ code: r.code });
    expect((await myRefunds(other.actor)).refunds).toEqual([]);
    await expect(getRefundRequest(other.actor, r.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The guardian is told too ("Junior's court booking").
    const g = await prisma.notificationDelivery.findFirstOrThrow({ where: { userId: parent.member.userId!, event: "REFUND_READY_TO_COLLECT", channel: "IN_APP" } });
    expect(g.body).toContain("for Junior's court booking");
    expect((await myPayments(parent.actor)).rows.some((x) => x.forName === "Junior Jai")).toBe(true);
  });

  it("§3.6: every refund event carries its WhatsApp template values — ready (QR button), rejected (reason), collected (date), unclaimed (QR button)", async () => {
    const { m, b } = await memberBooking("Wa Wahida Shah");
    await whatsappOn([m.memberId]);
    const r = await readyRefund(b.billId, 15000);
    expect(await waRow(m.memberId, "REFUND_READY_TO_COLLECT")).toMatchObject({ template: "refund_ready_to_collect", params: ["Wa", "150", r.code], button: refundCollectToken(r.id) });
    await runRefundReminders(new Date(T0.getTime() + 3 * DAY));
    expect(await waRow(m.memberId, "REFUND_UNCLAIMED_REMINDER")).toMatchObject({ template: "refund_unclaimed_reminder", params: ["Wa", "150", r.code], button: refundCollectToken(r.id) });
    clock.set(new Date(T0.getTime() + 4 * DAY));
    await payOutRefund(w.actors.FRONT_DESK, r.id, { method: "CASH", identityChecked: true });
    expect(await waRow(m.memberId, "REFUND_COLLECTED")).toMatchObject({ template: "refund_completed", params: ["Wa", "150", "16 Oct 2026", r.code], button: null });
    const no = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "GOODWILL", note: "asked again" });
    await rejectRefund(w.actors.MANAGER, no.id, "Already refunded");
    expect(await waRow(m.memberId, "REFUND_REJECTED")).toMatchObject({ template: "refund_rejected", params: ["Wa", no.code, "100", "Already refunded"] });
    await settleAfterCommit();
  });
});
