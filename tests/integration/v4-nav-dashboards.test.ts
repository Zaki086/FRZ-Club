// v4 §1: "Needs your approval" (RN-4), the role dashboards (RN-5), Check-in Risk (RN-6), the Owner's Employees screen
// and the RN-3 capability changes — against the real services and database.
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { addDays, dbDate, istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { login, actorFromToken } from "@/server/auth/sessions";
import { canOpenPage } from "@/server/rbac/page-access";
import { decideApproval, listApprovals } from "@/server/services/approvals";
import { checkinRisks } from "@/server/services/checkin-risk";
import { closeCourts } from "@/server/services/closures";
import { frontDeskToday, managerToday, ownerCash } from "@/server/services/dashboards";
import { listView } from "@/server/services/filters";
import { getRefundRequest, requestRefund } from "@/server/services/refunds";
import { openTab } from "@/server/services/bar";
import { requestLeave } from "@/server/services/staff";
import { forceLogout, updateStaff } from "@/server/services/users";
import { myTodo } from "@/server/services/todo";
import { makeWorld, TEST_PASSWORD, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Monday 12 Oct 2026, 10:00 IST
});

const paidBooking = (time = "18:00", court = "Court 1") => book(w, { court, time, players: [guest("Refund Ravi")], payment: { kind: "COUNTER", method: "CASH" } });
const kinds = async (role: keyof World["actors"]) => (await listApprovals(w.actors[role])).map((i) => `${i.kind}:${i.title}`);

describe("v4 RN-4 — Needs your approval", () => {
  it("RN-4: refund requests within the viewer's limit and never their own; above the limit only the Owner", async () => {
    const b = await paidBooking();
    const small = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "SERVICE_ISSUE", note: "lights failed" });
    const own = await requestRefund(w.actors.MANAGER, { billId: b.billId, amount: 5000, reason: "GOODWILL", note: "manager's own ask" });
    const gold = await makeMember(w, { name: "Gold Gita", plan: "GOLD", months: 12 });
    const big = await requestRefund(w.actors.FRONT_DESK, { billId: gold.billId!, amount: 600000, reason: "GOODWILL", note: "relocating" });

    const mgr = (await listApprovals(w.actors.MANAGER)).filter((i) => i.kind === "REFUND");
    expect(mgr.map((i) => i.id)).toEqual([small.id]); // not their own, not above ₹5,000
    expect(mgr[0]).toMatchObject({ amountPaise: 10000, requestedBy: "Farah Desk", href: `/app/refunds/${small.id}` });
    const owner = (await listApprovals(w.actors.OWNER)).filter((i) => i.kind === "REFUND").map((i) => i.id);
    expect(owner.sort()).toEqual([small.id, own.id, big.id].sort());
    // The detail page opens for the approver (RN-1 exception) — the same page as the approval notification.
    expect(canOpenPage("MANAGER", mgr[0].href)).toBe(true);
    for (const role of ["FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"] as const) expect(await listApprovals(w.actors[role])).toEqual([]);
  });

  it("RN-4: inline Approve / Reject go through the refund service (limits, audit); Reject needs a reason", async () => {
    const b = await paidBooking();
    const r1 = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "SERVICE_ISSUE", note: "lights failed" });
    const r2 = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 5000, reason: "GOODWILL", note: "second ask" });
    await decideApproval(w.actors.MANAGER, { kind: "REFUND", id: r1.id, decision: "APPROVE" });
    expect((await getRefundRequest(w.actors.MANAGER, r1.id)).status).toBe("APPROVED");
    await expect(decideApproval(w.actors.MANAGER, { kind: "REFUND", id: r2.id, decision: "REJECT" })).rejects.toThrow(/reason|why/i);
    await expect(decideApproval(w.actors.MANAGER, { kind: "REFUND", id: r2.id, decision: "REJECT", reason: "no" })).rejects.toThrow();
    await decideApproval(w.actors.MANAGER, { kind: "REFUND", id: r2.id, decision: "REJECT", reason: "Lights were fine — checked the log" });
    expect((await getRefundRequest(w.actors.MANAGER, r2.id)).status).toBe("REJECTED");
    expect(await prisma.auditLog.count({ where: { entityId: { in: [r1.id, r2.id] }, action: { in: ["refund_request.approved", "refund_request.rejected"] }, actorId: w.actors.MANAGER.userId } })).toBe(2);
    expect((await listApprovals(w.actors.MANAGER)).filter((i) => i.kind === "REFUND")).toEqual([]);
    // The front desk decides nothing, whatever it sends.
    const r3 = await requestRefund(w.actors.MANAGER, { billId: b.billId, amount: 1000, reason: "GOODWILL", note: "third ask" });
    await expect(decideApproval(w.actors.FRONT_DESK, { kind: "REFUND", id: r3.id, decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideApproval(w.actors.MANAGER, { kind: "REFUND", id: r3.id, decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" }); // own request
  });

  it("RN-4: leave requests wait for the Owner and Manager (never the person who asked); the notification opens the same page", async () => {
    await requestLeave(w.actors.FRONT_DESK, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-21", reason: "family function" });
    await requestLeave(w.actors.MANAGER, { type: "CASUAL", startDate: "2026-10-22", endDate: "2026-10-22", reason: "exam" });
    const mgr = (await listApprovals(w.actors.MANAGER)).filter((i) => i.kind === "LEAVE");
    expect(mgr.map((i) => i.title)).toEqual(["Leave · Farah Desk"]);
    expect(mgr[0].detail).toMatch(/Casual leave 20 Oct.*21 Oct.*\(2 days\) · family function/);
    expect((await listApprovals(w.actors.OWNER)).filter((i) => i.kind === "LEAVE").map((i) => i.title).sort()).toEqual(["Leave · Farah Desk", "Leave · Manish Manager"]);
    const note = await prisma.notification.findFirstOrThrow({ where: { type: "LEAVE_REQUESTED", body: { contains: "family function" } } });
    expect(note.link).toBe(mgr[0].href);
    expect(canOpenPage("MANAGER", mgr[0].href)).toBe(true);
    await expect(decideApproval(w.actors.MANAGER, { kind: "LEAVE", id: mgr[0].id, decision: "REJECT", reason: "" })).rejects.toThrow();
    await decideApproval(w.actors.MANAGER, { kind: "LEAVE", id: mgr[0].id, decision: "REJECT", reason: "Two people already off that week" });
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: mgr[0].id } })).status).toBe("REJECTED");
    const mine = (await listApprovals(w.actors.OWNER)).find((i) => i.kind === "LEAVE")!;
    await decideApproval(w.actors.OWNER, { kind: "LEAVE", id: mine.id, decision: "APPROVE" });
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("APPROVED");
    expect(await kinds("OWNER")).toEqual([]);
  });

  it("RN-4: attendance — flagged missing clock-outs that still need a correction (linked, not decided inline)", async () => {
    const a = await prisma.attendance.create({ data: { employeeId: w.actors.FRONT_DESK.employeeId!, clockIn: istToUtc("2026-10-11", "09:00"), missingFlaggedAt: istToUtc("2026-10-11", "23:00") } });
    await prisma.attendance.create({ data: { employeeId: w.actors.MANAGER.employeeId!, clockIn: istToUtc("2026-10-11", "09:00"), missingFlaggedAt: istToUtc("2026-10-11", "23:00") } });
    const mgr = (await listApprovals(w.actors.MANAGER)).filter((i) => i.kind === "ATTENDANCE");
    expect(mgr.map((i) => [i.id, i.title])).toEqual([[a.id, "Missing clock-out · Farah Desk"]]); // not their own
    expect(mgr[0].href).toBe(`/app/staff/attendance?flag=missing&employee=${w.actors.FRONT_DESK.employeeId}`);
    expect(canOpenPage("MANAGER", mgr[0].href)).toBe(true);
    expect((await listApprovals(w.actors.OWNER)).filter((i) => i.kind === "ATTENDANCE")).toHaveLength(2);
    await expect(decideApproval(w.actors.MANAGER, { kind: "ATTENDANCE", id: a.id, decision: "APPROVE" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // A correction (clock-out set) takes it off the panel.
    await prisma.attendance.update({ where: { id: a.id }, data: { clockOut: istToUtc("2026-10-11", "17:00") } });
    expect((await listApprovals(w.actors.MANAGER)).filter((i) => i.kind === "ATTENDANCE")).toEqual([]);
  });

  it("RN-4: the dashboard to-do panel no longer repeats what the approvals panel decides (refunds, leave, clock-outs)", async () => {
    expect((await myTodo(w.actors.OWNER)).items.map((i) => i.key)).toEqual(["priceRulesToApprove", "payrollToApprove", "dataRequests"]);
    expect((await myTodo(w.actors.MANAGER)).items).toEqual([]);
  });
});

describe("v4 RN-6 — Check-in Risk", () => {
  async function setMembership(memberId: string, start: string, end: string, status: "ACTIVE" | "EXPIRED") {
    await prisma.membership.updateMany({ where: { memberId }, data: { startDate: dbDate(start), endDate: dbDate(end), status } });
  }

  it("RN-6: unpaid, membership expiring ≤ 7 days, expired, dues, open tab and club-cancelled pending — each with its fix", async () => {
    const exp = await makeMember(w, { name: "Expiring Esha", plan: "SILVER" });
    await setMembership(exp.memberId, "2026-09-15", "2026-10-15", "ACTIVE");
    const old = await makeMember(w, { name: "Lapsed Lata", plan: "SILVER" });
    await setMembership(old.memberId, "2026-09-01", "2026-10-01", "EXPIRED");
    const owes = await makeMember(w, { name: "Owing Omar", plan: "GOLD", pay: false }); // membership bill unpaid → dues
    const tabby = await makeMember(w, { name: "Tab Tara", plan: "SILVER" });
    await openTab(w.actors.BAR_STAFF, { memberId: tabby.memberId });
    const chooser = await makeMember(w, { name: "Choice Chetan", plan: "SILVER" });
    await book(w, { court: "Court 3", date: "2026-10-13", time: "18:00", players: [{ memberId: chooser.memberId }], payment: { kind: "COUNTER", method: "UPI", reference: utr() } });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 3"].id], date: "2026-10-13", startTime: "17:00", endTime: "21:00", reason: "WET_COURT", note: "rain" });

    const soon = await book(w, { time: "11:00", players: [{ memberId: exp.memberId }, guest("Guest Gopal")] }); // unpaid, in the next 2 h
    await book(w, { court: "Court 2", time: "18:00", players: [{ memberId: old.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { court: "Court 4", time: "19:00", players: [{ memberId: owes.memberId }, { memberId: tabby.memberId }, { memberId: chooser.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { court: "Court 2", time: "11:00", players: [guest("Fine Farid")], payment: { kind: "COUNTER", method: "CASH" } }); // no problem
    await book(w, { court: "Court 1", date: "2026-10-13", time: "18:00", players: [guest("Tomorrow Tom")] }); // beyond today and 2 h

    const r = await checkinRisks(w.actors.FRONT_DESK);
    expect(r.arrivals.map((a) => [a.code, a.soon])).toEqual([[soon.bookingCode, true], [expect.any(String), false], [expect.any(String), false]]);
    const all = r.arrivals.flatMap((a) => a.risks.map((x) => `${x.kind}:${x.who}`));
    expect(all.sort()).toEqual([
      "CLUB_CANCELLED_PENDING:Choice Chetan", "DUES:Owing Omar", "MEMBERSHIP_EXPIRED:Lapsed Lata", "MEMBERSHIP_EXPIRING:Expiring Esha",
      "OPEN_TAB:Tab Tara", "UNPAID:Expiring Esha, Guest Gopal",
    ].sort());
    const first = r.arrivals[0].risks;
    expect(first.find((x) => x.kind === "UNPAID")).toMatchObject({ amountPaise: expect.any(Number), fix: { label: expect.stringMatching(/^Collect ₹/), href: `/app/courts/bookings?q=${soon.bookingCode}` } });
    expect(first.find((x) => x.kind === "MEMBERSHIP_EXPIRING")).toMatchObject({ problem: "Membership ends 15 Oct 2026", fix: { label: "Renew", href: `/app/members/${exp.memberId}` } });
    const dues = r.arrivals.flatMap((a) => a.risks).find((x) => x.kind === "DUES")!;
    expect(dues).toMatchObject({ fix: { href: `/app/members/${owes.memberId}` }, amountPaise: expect.any(Number) });
    expect(dues.fix.label).toMatch(/^Collect ₹/);
    // The front desk can't settle a bar tab: its fix opens the member page; the bar's opens the tab.
    expect(r.arrivals.flatMap((a) => a.risks).find((x) => x.kind === "OPEN_TAB")!.fix).toMatchObject({ label: "Settle at the bar", href: `/app/members/${tabby.memberId}` });
    // Every fix opens for the front desk (RN-1).
    for (const x of r.arrivals.flatMap((a) => a.risks)) expect(canOpenPage("FRONT_DESK", x.fix.href), x.fix.href).toBe(true);
    expect(r.counts).toMatchObject({ UNPAID: 1, MEMBERSHIP_EXPIRING: 1, MEMBERSHIP_EXPIRED: 1, DUES: 1, OPEN_TAB: 1, CLUB_CANCELLED_PENDING: 1 });
    expect([r.total, r.soon]).toEqual([3, 1]);
    await expect(checkinRisks(w.actors.SHOP_STAFF)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("RN-6: players already checked in and renewals already lined up are not risks", async () => {
    const exp = await makeMember(w, { name: "Renewed Rina", plan: "SILVER" });
    await prisma.membership.updateMany({ where: { memberId: exp.memberId }, data: { startDate: dbDate("2026-09-15"), endDate: dbDate("2026-10-15") } });
    const plan = await prisma.membership.findFirstOrThrow({ where: { memberId: exp.memberId } });
    await prisma.membership.create({ data: { memberId: exp.memberId, planId: plan.planId, startDate: dbDate("2026-10-16"), endDate: dbDate("2026-11-15"), durationMonths: 1, status: "SCHEDULED", price: plan.price } });
    await book(w, { time: "11:00", players: [{ memberId: exp.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const b = await book(w, { court: "Court 2", time: "10:00", players: [guest("Early Eli")] });
    await prisma.bookingPlayer.updateMany({ where: { bookingId: b.bookingId }, data: { checkedInAt: clock.now() } });
    expect((await checkinRisks(w.actors.FRONT_DESK)).arrivals).toEqual([]);
  });
});

describe("v4 RN-5 — dashboards", () => {
  it("RN-5: Manager — today's operations, every number opening a list on the Manager's menu", async () => {
    await paidBooking("18:00");
    await book(w, { court: "Court 2", time: "19:00", players: [guest("Cancel Chandu")] });
    const t = await managerToday(w.actors.MANAGER);
    expect(t.bookings.value).toBe(2);
    expect(t.bookings.value).toBe((await listView(w.actors.MANAGER, "bookings", { range: "TODAY", status: "CONFIRMED,COMPLETED,NO_SHOW" })).total);
    expect(t.utilization.pct).toBeGreaterThan(0);
    expect(t.staff.clockedIn.value).toBe(0);
    const hrefs = [t.utilization.href, t.bookings.href, t.noShows.href, t.cancellations.href, t.clubCancellationsPending.href, t.bar.collected.href, t.bar.openTabs.href, t.shop.sales.href, t.shop.total.href, t.staff.clockedIn.href, t.staff.notIn.href, t.staff.onLeave.href];
    for (const h of hrefs) expect(canOpenPage("MANAGER", h), h).toBe(true);
    await expect(managerToday(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("RN-5: Front desk — drawer, arrivals in 2 h, check-in risks, refunds to pay out, renewals, messages, overdue leads", async () => {
    const exp = await makeMember(w, { name: "Expiring Esha", plan: "SILVER" });
    await prisma.membership.updateMany({ where: { memberId: exp.memberId }, data: { startDate: dbDate("2026-09-15"), endDate: dbDate(addDays("2026-10-12", 3)) } });
    await book(w, { time: "11:00", players: [{ memberId: exp.memberId }, guest("Pal Pia")] });
    const d = await frontDeskToday(w.actors.FRONT_DESK);
    expect(d.drawer.balancePaise).not.toBeNull(); // the test club opens every drawer
    expect(d.arrivals.value).toBe(2);
    expect(d.risks).toMatchObject({ value: 1, soon: 1 });
    expect(d.renewals.value).toBe(1);
    expect(d.refundsReady.value).toBe(0);
    expect(d.messagesToSend?.value).toBeGreaterThanOrEqual(0);
    expect(d.overdueLeads?.value).toBe(0);
    const hrefs = [d.drawer.href, d.arrivals.href, d.risks.href, d.refundsReady.href, d.renewals.href, d.messagesToSend!.href, d.overdueLeads!.href, ...d.arrivals.items.map((a) => a.href)];
    for (const h of hrefs) expect(canOpenPage("FRONT_DESK", h), h).toBe(true);
    await expect(frontDeskToday(w.actors.SHOP_STAFF)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("RN-5: Owner — cash summary (collected today, in drawers, in the safe, refunds payable)", async () => {
    await paidBooking("18:00");
    const c = await ownerCash(w.actors.OWNER);
    expect(c.collectedToday.value).toBe(40000);
    expect(c.inDrawers.value).toBeGreaterThanOrEqual(40000);
    expect(c.refundsPayable).toMatchObject({ value: 0, count: 0 });
    await expect(ownerCash(w.actors.MANAGER)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v4 §1.2 — Employees (Owner)", () => {
  it("the Owner changes role, salary and join date (audited); nobody else can; the Owner can't change their own role", async () => {
    const fd = w.actors.FRONT_DESK;
    await updateStaff(w.actors.OWNER, fd.userId, { role: "SHOP_STAFF", monthlySalary: 3_500_000, joinDate: "2025-02-01" });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: fd.userId }, include: { employee: true } });
    expect([u.role, u.employee?.monthlySalary]).toEqual(["SHOP_STAFF", 3_500_000]);
    expect(await prisma.auditLog.count({ where: { action: "user.update", entityId: fd.userId } })).toBe(1);
    await expect(updateStaff(w.actors.MANAGER, fd.userId, { monthlySalary: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateStaff(w.actors.OWNER, w.actors.OWNER.userId, { role: "MANAGER" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("force logout ends every session of that person now (audited)", async () => {
    const s = await login("9000000003", TEST_PASSWORD);
    expect(await actorFromToken(s.token)).not.toBeNull();
    const r = await forceLogout(w.actors.OWNER, w.actors.FRONT_DESK.userId);
    expect(r.sessionsEnded).toBe(1);
    expect(await actorFromToken(s.token)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "user.force_logout", entityId: w.actors.FRONT_DESK.userId } })).toBe(1);
    await expect(forceLogout(w.actors.MANAGER, w.actors.FRONT_DESK.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
