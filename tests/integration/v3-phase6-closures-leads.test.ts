// v3 phase 6: club cancellations (§7.2 CC-1…CC-8) and lead assignment (§8.2 LA-1…LA-8).
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import type { UserActor } from "@/server/rbac/actor";
import { SYSTEM } from "@/server/rbac/actor";
import { closeCourts, previewClosure, refundClubCancellation, rescheduleClubCancellation } from "@/server/services/closures";
import { createBooking } from "@/server/services/booking";
import { createSocialSession, joinSession } from "@/server/services/social";
import { listView } from "@/server/services/filters";
import { runDailyJobs } from "@/server/jobs";
import { assignLead, createLead, createTrialBooking, flagOverdueLeads } from "@/server/services/crm";
import { assignShift, clockIn, clockOut } from "@/server/services/staff";
import { createStaff, setUserActive } from "@/server/services/users";
import { requestRefundAsMember } from "@/server/services/refunds";
import { makeWorld, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const wet = (over: Partial<{ start: string; end: string; date: string }> = {}) => ({
  courtIds: [w.courts["Court 1"].id], date: over.date ?? "2026-10-12", startTime: over.start ?? "17:00", endTime: over.end ?? "21:00", reason: "WET_COURT" as const, note: "Rain overnight",
});

describe("v3 §7.2 — club cancellations", () => {
  it("CC-1/CC-2/CC-3/CC-7: a wet-court closure over 3 bookings — preview with amounts, all cancelled and notified, court blocked", async () => {
    const m = await makeMember(w, { name: "Rain Riya", plan: "SILVER" });
    const b1 = await book(w, { time: "17:00", players: [guest("Paid Pavan")], payment: { kind: "COUNTER", method: "CASH" } });
    const b2 = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, { guest: { name: "Friend Farhan", phone: "9876540001" } }], payment: { kind: "COUNTER", method: "UPI", reference: utr() } });
    const b3 = await book(w, { time: "19:00", players: [{ guest: { name: "Unpaid Usha", phone: "9876540002" } }] });
    const other = await book(w, { court: "Court 2", time: "18:00", players: [guest("Elsewhere Eli")] });

    const p = await previewClosure(w.actors.MANAGER, wet());
    expect(p.bookings.map((b) => [b.code, b.paid])).toEqual([[b1.bookingCode, 40000], [b2.bookingCode, 55000], [b3.bookingCode, 0]]); // member ₹150 + guest ₹400
    expect(p.totals).toMatchObject({ bookings: 3, paidBookings: 2, paid: 95000 });
    await expect(previewClosure(w.actors.FRONT_DESK, wet())).rejects.toMatchObject({ code: "FORBIDDEN" });

    const r = await closeCourts(w.actors.MANAGER, wet());
    expect(r).toMatchObject({ cancelledBookings: 3, pendingChoice: 2 });
    const statuses = await prisma.booking.findMany({ where: { id: { in: [b1.bookingId, b2.bookingId, b3.bookingId, other.bookingId] } }, orderBy: { bookingCode: "asc" } });
    expect(statuses.map((b) => b.status)).toEqual(["CANCELLED_BY_CLUB", "CANCELLED_BY_CLUB", "CANCELLED_BY_CLUB", "CONFIRMED"]);
    expect(statuses[0].cancelReason).toMatch(/Wet court: Rain overnight/);
    // CC-7: the unpaid one owes nothing and has no choice to make.
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b3.billId } })).closedAt).not.toBeNull();
    expect(await prisma.clubCancellation.count({ where: { bookingId: b3.bookingId } })).toBe(0);
    // CC-3: the member hears it on every channel; guests with a phone get a manual WhatsApp.
    expect(await prisma.notificationDelivery.count({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED_BY_CLUB" } })).toBe(5);
    const guestTasks = await prisma.notificationDelivery.findMany({ where: { guestId: { not: null }, channel: "WHATSAPP_MANUAL" } });
    expect(guestTasks.map((d) => d.toAddress).sort()).toEqual(["919876540001", "919876540002"]);
    // The court is blocked: nothing can be booked inside the closed range.
    await expect(book(w, { time: "18:00", players: [guest("Hopeful Hari")] })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    expect((await prisma.courtReservation.findMany({ where: { closureId: r.closureId } })).map((x) => x.kind)).toEqual(["MAINTENANCE"]);
    // CC-8: the bookings list filters club cancellations waiting for a choice.
    const pending = await listView(w.actors.FRONT_DESK, "bookings", { resolution: "PENDING_CHOICE" });
    expect(pending.total).toBe(2);
    await expectIntegrity();
  });

  it("CC-2: a member's daily play is freed, and social sessions on the closed court are cancelled and refunded", async () => {
    const m = await makeMember(w, { name: "Daily Dina", plan: "SILVER" });
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    const sessions = await createSocialSession(w.actors.MANAGER, { title: "Evening social", date: "2026-10-12", startTime: "20:00", endTime: "21:00", courtIds: [w.courts["Court 1"].id], capacityPerCourt: 8 });
    const sessionId = sessions.sessions[0].id;
    await joinSession(w.actors.FRONT_DESK, { sessionId, player: guest("Social Sam"), payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    expect((await prisma.socialSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("CANCELLED");
    const part = await prisma.socialParticipant.findFirstOrThrow({ where: { sessionId } });
    expect(part.status).toBe("CANCELLED_BY_CLUB");
    const refund = await prisma.refundRequest.findFirstOrThrow({ where: { billId: part.billId! } });
    // v4 RF-8/RF-9: the manager's drawer holds no cash, so the cash refund waits at the desk (ready to collect).
    expect([refund.reason, refund.autoApproved, refund.status, refund.collectStatus]).toEqual(["CLUB_CANCELLATION", true, "APPROVED", "READY_TO_COLLECT"]);
    expect(await prisma.payment.count({ where: { refundRequestId: refund.id, type: "REFUND", status: "PENDING" } })).toBe(1);
    // The member's play for that day no longer counts: they can book twice more on another court.
    await book(w, { court: "Court 2", time: "18:00", players: [{ memberId: m.memberId }] });
    await book(w, { court: "Court 2", time: "19:00", players: [{ memberId: m.memberId }] });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).status).toBe("CANCELLED_BY_CLUB");
    await expectIntegrity();
  });

  it("CC-4: the booker reschedules once, within the window, all booking rules apply, and nothing more is charged", async () => {
    const m = await makeMember(w, { name: "Move Meera", plan: "SILVER" });
    const other = await makeMember(w, { name: "Other Om", plan: "SILVER" });
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, guest("Guest Gaurav")], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    expect([cc.status, cc.amountPaid]).toEqual(["PENDING_CHOICE", 55000]);
    await expect(rescheduleClubCancellation(other.actor, cc.id, { courtId: w.courts["Court 2"].id, date: "2026-10-14", startTime: "18:00" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rescheduleClubCancellation(m.actor, cc.id, { courtId: w.courts["Court 2"].id, date: "2026-10-27", startTime: "18:00" })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
    await book(w, { court: "Court 2", date: "2026-10-14", time: "18:00", players: [{ memberId: other.memberId }] });
    await expect(rescheduleClubCancellation(m.actor, cc.id, { courtId: w.courts["Court 2"].id, date: "2026-10-14", startTime: "18:00" })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    // Day 12 is beyond a Silver member's usual window but inside the 14-day reschedule window. Two players → the same
    // fees as before; whatever the new slot costs, the new bill is ₹0 and no payment is taken.
    const payments = await prisma.payment.count();
    const r = await rescheduleClubCancellation(m.actor, cc.id, { courtId: w.courts["Court 2"].id, date: "2026-10-24", startTime: "19:00" });
    expect([r.booking.total, r.booking.billStatus, r.booking.due]).toEqual([0, "PAID", 0]);
    expect(r.booking.players.every((p) => /moved from BK-\d+ after a club cancellation/.test(p.explanation))).toBe(true);
    expect(await prisma.payment.count()).toBe(payments);
    expect((await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } })).status).toBe("RESCHEDULED");
    await expect(rescheduleClubCancellation(m.actor, cc.id, { courtId: w.courts["Court 3"].id, date: "2026-10-24", startTime: "19:00" })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expect(refundClubCancellation(m.actor, cc.id)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expectIntegrity();
  });

  it("CC-5: refund in full as an approved request even inside the 2-hour window; the portal refund uses the same choice", async () => {
    clock.set(istToUtc("2026-10-12", "17:30"));
    const m = await makeMember(w, { name: "Late Lata", plan: "SILVER" });
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, guest("Buddy Bala")], payment: { kind: "COUNTER", method: "CASH" } });
    const b2 = await book(w, { time: "19:00", players: [{ memberId: m.memberId }, guest("Buddy Bobby")], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet({ start: "18:00" }));
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    const r = await refundClubCancellation(w.actors.FRONT_DESK, cc.id);
    const req = await prisma.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect([req.reason, req.policy, req.amount, req.autoApproved, req.status]).toEqual(["CLUB_CANCELLATION", "CC-5", 55000, true, "APPROVED"]); // cash → ready to pay out
    expect((await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } })).status).toBe("REFUNDED");
    // Asking from the portal resolves the same choice.
    const cc2 = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b2.bookingId } });
    await requestRefundAsMember(m.actor, { billId: b2.billId });
    expect((await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc2.id } })).status).toBe("REFUNDED");
    await expectIntegrity();
  });

  it("CC-6: no choice by the deadline → refunded automatically (online money goes straight back)", async () => {
    const m = await makeMember(w, { name: "Quiet Qadir", plan: "SILVER" });
    const b = await createBooking(w.actors.FRONT_DESK, { courtId: w.courts["Court 1"].id, date: "2026-10-12", startTime: "18:00", players: [{ memberId: m.memberId }, { guest: { name: "Guest Gita" } }], channel: "FRONT_DESK", payment: { kind: "COUNTER", method: "UPI", reference: utr() } });
    await closeCourts(w.actors.MANAGER, wet());
    clock.set(istToUtc("2026-10-18", "10:00"));
    expect((await runDailyJobs()).clubCancellations.refunded).toBe(0);
    clock.set(istToUtc("2026-10-19", "10:01"));
    expect((await runDailyJobs()).clubCancellations.refunded).toBe(1);
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    expect([cc.status, cc.resolvedVia]).toEqual(["REFUNDED", "AUTO"]);
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: cc.refundRequestId! } })).policy).toBe("CC-6");
    await expectIntegrity();
  });
});

async function staff(name: string, phone: string, role: "FRONT_DESK" | "MANAGER") {
  const r = await createStaff(SYSTEM, { name, phone, role, password: "password123", monthlySalary: 2_500_000, joinDate: "2025-01-01" });
  const actor: UserActor = { kind: "USER", userId: r.user.id, role, name, memberId: null, employeeId: r.employee.id };
  return actor;
}

describe("v3 §8.2 — lead assignment", () => {
  const lead = (name: string, interest = "") => createLead(w.actors.OWNER, { name, phone: `98765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, source: "PHONE", interest });
  const assignee = async (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });

  it("LA-2: front desk clocked in, fewest open leads; a tie goes to whoever waited longest", async () => {
    const desk2 = await staff("Dev Desk", "9000000098", "FRONT_DESK");
    await clockIn(w.actors.FRONT_DESK);
    await clockIn(desk2);
    const a = await lead("Lead A");
    clock.advance(60_000);
    const b = await lead("Lead B");
    clock.advance(60_000);
    const c = await lead("Lead C");
    const [la, lb, lc] = await Promise.all([assignee(a.id), assignee(b.id), assignee(c.id)]);
    expect(la.assignedTo).not.toBe(lb.assignedTo); // 0 open each: alphabetical first, then the other
    expect(lc.assignedTo).toBe(la.assignedTo); // 1 open each → whoever was assigned longest ago
    expect(lc.assignmentReason).toBe("LA-2: clocked in, 1 open leads");
  });

  it("LA-1: corporate enquiries go to a manager on shift, else any manager", async () => {
    await clockIn(w.actors.FRONT_DESK);
    const a = await lead("Corp One", "Corporate membership for 20 staff");
    expect((await assignee(a.id))).toMatchObject({ assignedTo: w.actors.MANAGER.userId, assignmentReason: expect.stringMatching(/^LA-1: corporate enquiry → manager \(none on shift\)/) });
    const mgr2 = await staff("Second Manager", "9000000097", "MANAGER");
    await clockIn(mgr2);
    const b = await lead("Corp Two", "Business client — team event");
    expect((await assignee(b.id))).toMatchObject({ assignedTo: mgr2.userId, assignmentReason: expect.stringMatching(/^LA-1: corporate enquiry → manager on shift/) });
  });

  it("LA-3/LA-4: nobody clocked in → next on the roster; nobody rostered → a manager, then the owner", async () => {
    const desk2 = await staff("Dev Desk", "9000000098", "FRONT_DESK");
    await assignShift(w.actors.MANAGER, { employeeId: desk2.employeeId!, date: "2026-10-12", startTime: "14:00", endTime: "22:00", area: "FRONT_DESK" });
    await assignShift(w.actors.MANAGER, { employeeId: w.actors.FRONT_DESK.employeeId!, date: "2026-10-13", startTime: "06:00", endTime: "14:00", area: "FRONT_DESK" });
    const a = await lead("Rostered Ravi");
    expect(await assignee(a.id)).toMatchObject({ assignedTo: desk2.userId, assignmentReason: expect.stringMatching(/^LA-3: nobody clocked in → next on the roster at 12 Oct 2026, 14:00/) });
    clock.set(istToUtc("2026-10-14", "10:00")); // nobody rostered today or tomorrow
    const b = await lead("Nobody Nina");
    expect(await assignee(b.id)).toMatchObject({ assignedTo: w.actors.MANAGER.userId, assignmentReason: expect.stringMatching(/^LA-4: no front desk on the roster → manager/) });
    await setUserActive(w.actors.OWNER, w.actors.MANAGER.userId, false);
    const c = await lead("Owner Omar");
    expect(await assignee(c.id)).toMatchObject({ assignedTo: w.actors.OWNER.userId, assignmentReason: "LA-4: no front desk or manager → owner" });
  });

  it("LA-5/LA-6: a trial lead is assigned at creation; the assignee is told in the app and by push; the reason is stored", async () => {
    await clockIn(w.actors.FRONT_DESK);
    await createTrialBooking({ consent: true, name: "Trial Tanvi", phone: "9876543299", courtId: w.courts["Court 2"].id, date: "2026-10-12", startTime: "19:00" });
    const l = await prisma.lead.findFirstOrThrow({ where: { name: "Trial Tanvi" } });
    expect([l.assignedTo, l.assignmentReason]).toEqual([w.actors.FRONT_DESK.userId, "LA-2: clocked in, 0 open leads"]);
    const d = await prisma.notificationDelivery.findMany({ where: { userId: w.actors.FRONT_DESK.userId, event: "LEAD_ASSIGNED" } });
    expect(d.map((x) => x.channel).sort()).toEqual(["IN_APP", "PUSH"]);
  });

  it("LA-7: a manager reassigns with a reason (both told); the desk can't; deactivating someone reassigns their open leads", async () => {
    const desk2 = await staff("Dev Desk", "9000000098", "FRONT_DESK");
    await clockIn(w.actors.FRONT_DESK);
    const a = await lead("Move Me");
    await expect(assignLead(w.actors.FRONT_DESK, a.id, desk2.userId, "swap")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assignLead(w.actors.MANAGER, a.id, desk2.userId, "")).rejects.toThrow();
    await assignLead(w.actors.MANAGER, a.id, desk2.userId, "Speaks Gujarati");
    expect((await assignee(a.id)).assignmentReason).toBe("LA-7: reassigned by Manish Manager — Speaks Gujarati");
    expect(await prisma.notification.count({ where: { userId: w.actors.FRONT_DESK.userId, type: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: desk2.userId, type: "LEAD_ASSIGNED" } })).toBe(1);
    await clockIn(desk2);
    await clockOut(w.actors.FRONT_DESK);
    await clockIn(w.actors.FRONT_DESK);
    await setUserActive(w.actors.OWNER, desk2.userId, false);
    expect(await assignee(a.id)).toMatchObject({ assignedTo: w.actors.FRONT_DESK.userId, assignmentReason: "LA-7: Dev Desk was deactivated → LA-2: clocked in, 0 open leads" });
  });

  it("LA-8: a follow-up still overdue 48 hours later is escalated to the managers, once", async () => {
    const a = await lead("Slow Sunil");
    clock.advance(25 * 3600_000); // overdue (24h follow-up)
    expect((await flagOverdueLeads()).escalated).toBe(0);
    clock.advance(48 * 3600_000);
    expect((await flagOverdueLeads()).escalated).toBe(1);
    expect((await flagOverdueLeads()).escalated).toBe(0);
    expect((await assignee(a.id)).escalatedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: w.actors.MANAGER.userId, type: "LEAD_ESCALATED" } })).toBe(1);
  });
});
