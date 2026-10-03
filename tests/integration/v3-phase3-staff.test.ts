// v3 phase 3: sliding sessions (§6.1), leave date validation (LV-1…LV-3), staff directory and attendance (§4, AT-1…AT-6).
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { actorFromToken, login, makeKioskSession, revokeSessions, SESSION_POLICY } from "@/server/auth/sessions";
import { assignShift, clockIn, clockOut, decideLeave, employeeDetail, expireStaleLeave, requestLeave } from "@/server/services/staff";
import { correctAttendance, flagMissingClockouts } from "@/server/services/attendance";
import { listExport, listView } from "@/server/services/filters";
import { runDailyJobs } from "@/server/jobs";
import { closeDrawer } from "@/server/services/drawers";
import { makeWorld, TEST_PASSWORD, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";

let w: World;
const DAY = 86_400_000;
type Facet = { key: string; options: Array<{ value: string; count: number }> };
const count = (facets: Facet[], key: string, value: string) => facets.find((f) => f.key === key)!.options.find((o) => o.value === value)?.count ?? 0;
const at = (date: string, time: string) => clock.set(istToUtc(date, time));

beforeEach(async () => {
  w = await makeWorld();
});

describe("v3 §6.1 — sliding sessions", () => {
  it("staff: 7 days idle / 30 days absolute; members: 30 / 90; the cookie gets the absolute end", async () => {
    const t = Date.now();
    const staff = await login("9000000003", TEST_PASSWORD);
    const row = await prisma.session.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId } });
    expect(row.kind).toBe("STAFF");
    expect(row.expiresAt.getTime() - t).toBeGreaterThanOrEqual(7 * DAY - 60_000);
    expect(row.expiresAt.getTime() - t).toBeLessThan(7 * DAY + 60_000);
    expect(staff.expiresAt.getTime()).toBe(row.absoluteExpiresAt!.getTime());
    expect(row.absoluteExpiresAt!.getTime() - t).toBeGreaterThanOrEqual(30 * DAY - 60_000);

    const m = await makeMember(w, { name: "Session Sia", plan: "SILVER" });
    await login(m.member.phone, "member123");
    const mrow = await prisma.session.findFirstOrThrow({ where: { userId: m.member.userId! } });
    expect(mrow.kind).toBe("MEMBER");
    expect(Math.round((mrow.expiresAt.getTime() - t) / DAY)).toBe(SESSION_POLICY.MEMBER.idleDays);
    expect(Math.round((mrow.absoluteExpiresAt!.getTime() - t) / DAY)).toBe(SESSION_POLICY.MEMBER.absoluteDays);
  });

  it("extends the idle window only when less than half is left, at most once per 10 minutes, never past the absolute end", async () => {
    const s = await login("9000000003", TEST_PASSWORD);
    const id = (await prisma.session.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId } })).id;
    const now = Date.now();
    // More than half the window left: no write.
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(now + 5 * DAY), lastSeenAt: new Date(now - DAY) } });
    expect(await actorFromToken(s.token)).not.toBeNull();
    expect((await prisma.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime()).toBe(now + 5 * DAY);
    // Less than half left but seen 5 minutes ago: still no write.
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(now + 2 * DAY), lastSeenAt: new Date(now - 5 * 60_000) } });
    await actorFromToken(s.token);
    expect((await prisma.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime()).toBe(now + 2 * DAY);
    // Less than half left, last write an hour ago: slides to now + 7 days.
    await prisma.session.update({ where: { id }, data: { lastSeenAt: new Date(now - 3_600_000) } });
    await actorFromToken(s.token);
    const slid = await prisma.session.findUniqueOrThrow({ where: { id } });
    expect(slid.expiresAt.getTime()).toBeGreaterThanOrEqual(now + 7 * DAY - 60_000);
    // Capped by the absolute end.
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(now + DAY), absoluteExpiresAt: new Date(now + 2 * DAY), lastSeenAt: new Date(now - 3_600_000) } });
    await actorFromToken(s.token);
    expect((await prisma.session.findUniqueOrThrow({ where: { id } })).expiresAt.getTime()).toBe(now + 2 * DAY);
    // Past the absolute end (or the idle end): signed out.
    await prisma.session.update({ where: { id }, data: { absoluteExpiresAt: new Date(now - 1000) } });
    expect(await actorFromToken(s.token)).toBeNull();
  });

  it("kiosk: checkin staff can turn their session into a 90-day kiosk session; revocation is still immediate", async () => {
    const desk = await login("9000000003", TEST_PASSWORD);
    await expect(makeKioskSession(desk.token, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const k = await makeKioskSession(desk.token, true);
    expect(Math.round((k.expiresAt.getTime() - Date.now()) / DAY)).toBe(90);
    expect((await prisma.session.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId } })).kind).toBe("KIOSK");
    expect(await actorFromToken(desk.token)).not.toBeNull();
    await revokeSessions(w.actors.FRONT_DESK.userId);
    expect(await actorFromToken(desk.token)).toBeNull();
    await expect(makeKioskSession(desk.token, true)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("v3 §9.1 — leave date validation", () => {
  it("LV-1: a request starting before today (IST) → LEAVE_DATE_IN_PAST; today is fine", async () => {
    await expect(requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-11", endDate: "2026-10-12", reason: "late ask" })).rejects.toMatchObject({ code: "LEAVE_DATE_IN_PAST" });
    expect((await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-12", endDate: "2026-10-12", reason: "today" })).days).toBe(1);
  });

  it("LV-2: end ≥ start; overlapping own PENDING/APPROVED leave → LEAVE_OVERLAP; rejected leave does not block", async () => {
    await expect(requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-19", reason: "backwards" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const lr = await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-22", reason: "trip" });
    await expect(requestLeave(w.actors.SHOP_STAFF, { type: "SICK", startDate: "2026-10-22", endDate: "2026-10-23", reason: "overlap" })).rejects.toMatchObject({ code: "LEAVE_OVERLAP" });
    await decideLeave(w.actors.MANAGER, lr.id, "REJECTED", "busy week");
    expect((await requestLeave(w.actors.SHOP_STAFF, { type: "SICK", startDate: "2026-10-22", endDate: "2026-10-23", reason: "after rejection" })).days).toBe(2);
    // Someone else's leave never overlaps yours.
    expect((await requestLeave(w.actors.BAR_STAFF, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-22", reason: "same days" })).days).toBe(3);
  });

  it("LV-3: approval re-validates; a PENDING request whose start has passed can't be approved and the daily job expires it and tells the employee", async () => {
    const lr = await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-13", endDate: "2026-10-14", reason: "wedding" });
    at("2026-10-14", "09:00");
    await expect(decideLeave(w.actors.MANAGER, lr.id, "APPROVED")).rejects.toMatchObject({ code: "LEAVE_DATE_IN_PAST" });
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } })).status).toBe("PENDING");
    const r = await runDailyJobs();
    expect(r.leave.expired).toBe(1);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } })).status).toBe("EXPIRED");
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: w.actors.SHOP_STAFF.userId, title: "Leave request expired" } });
    expect(note.body).toMatch(/13 Oct 2026/);
    expect((await expireStaleLeave()).expired).toBe(0);
    await expect(decideLeave(w.actors.MANAGER, lr.id, "APPROVED")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // An expired request no longer holds the dates or the allowance.
    expect((await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-14", endDate: "2026-10-14", reason: "again" })).days).toBe(1);
  });

  it("LV-3: approving re-checks overlap with the employee's approved leave", async () => {
    const a = await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-21", reason: "first" });
    await decideLeave(w.actors.MANAGER, a.id, "APPROVED");
    // A request that predates LV-2 (written directly, as older data may be).
    const legacy = await prisma.leaveRequest.create({ data: { employeeId: w.actors.SHOP_STAFF.employeeId!, type: "SICK", startDate: istToUtc("2026-10-21"), endDate: istToUtc("2026-10-21"), days: 1, reason: "old" } });
    await expect(decideLeave(w.actors.MANAGER, legacy.id, "APPROVED")).rejects.toMatchObject({ code: "LEAVE_OVERLAP" });
  });
});

describe("v3 §4.3 — attendance rules", () => {
  async function day() {
    const desk = w.actors.FRONT_DESK;
    const bar = w.actors.BAR_STAFF;
    await assignShift(w.actors.MANAGER, { employeeId: desk.employeeId!, date: "2026-10-12", startTime: "10:00", endTime: "18:00", area: "FRONT_DESK" });
    await assignShift(w.actors.MANAGER, { employeeId: bar.employeeId!, date: "2026-10-12", startTime: "10:00", endTime: "14:00", area: "BAR" });
    at("2026-10-12", "10:05");
    const b = await clockIn(bar); // within the 10-minute grace
    at("2026-10-12", "10:15");
    const d = await clockIn(desk); // 15 minutes late
    at("2026-10-12", "18:45");
    await clockOut(desk); // worked 8:30 against 8:00 scheduled → overtime 30 is not over the threshold
    return { desk, bar, b, d };
  }

  it("AT-1/2/3: worked = out − in (h:mm); late only beyond the grace; overtime only beyond the threshold", async () => {
    const { d, b } = await day();
    let r = await listView(w.actors.MANAGER, "attendance", { range: "TODAY" });
    const desk = r.rows.find((x) => x.id === d.id)!;
    const bar = r.rows.find((x) => x.id === b.id)!;
    expect([desk.worked_min, desk.scheduled_min, desk.late_min, desk.early_min, desk.overtime_min]).toEqual([510, 480, 15, 0, 0]);
    expect([bar.late_min, bar.worked_min]).toEqual([0, null]);
    expect(count(r.facets, "flag", "late")).toBe(1);
    expect(count(r.facets, "flag", "overtime")).toBe(0);
    // Lower the overtime threshold: the same day now shows 30 minutes of overtime.
    await prisma.setting.update({ where: { key: "overtime_threshold_minutes" }, data: { value: 20 } });
    r = await listView(w.actors.MANAGER, "attendance", { range: "TODAY", flag: "overtime" });
    expect(r.rows.map((x) => [x.name, x.overtime_min])).toEqual([["Farah Desk", 30]]);
    expect(r.summary.find((s) => s.key === "worked")!.value).toBe(510);
  });

  it("AT-4: still open 4 hours after the shift end → flagged once, Manager notified, never auto-closed", async () => {
    const { b } = await day();
    at("2026-10-12", "17:59");
    expect((await flagMissingClockouts()).flagged).toBe(0);
    at("2026-10-12", "18:01");
    expect((await flagMissingClockouts()).flagged).toBe(1);
    expect((await flagMissingClockouts()).flagged).toBe(0);
    const a = await prisma.attendance.findUniqueOrThrow({ where: { id: b.id } });
    expect(a.clockOut).toBeNull();
    expect(a.missingFlaggedAt).not.toBeNull();
    const n = await prisma.notification.findMany({ where: { type: "MISSING_CLOCK_OUT" } });
    expect(n.length).toBeGreaterThan(0);
    expect(n[0].title).toBe("Missing clock-out: Bina Bar");
  });

  it("AT-5: a Manager corrects with a mandatory reason; the original is kept, audited and marked edited; no self-correction", async () => {
    const { b, d } = await day();
    at("2026-10-12", "19:00");
    await expect(correctAttendance(w.actors.MANAGER, b.id, { clockOut: istToUtc("2026-10-12", "14:00"), reason: "" })).rejects.toThrow(/reason/);
    await expect(correctAttendance(w.actors.FRONT_DESK, b.id, { clockOut: istToUtc("2026-10-12", "14:00"), reason: "forgot" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(correctAttendance(w.actors.MANAGER, b.id, { clockOut: istToUtc("2026-10-12", "09:00"), reason: "typo" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await correctAttendance(w.actors.MANAGER, b.id, { clockOut: istToUtc("2026-10-12", "14:00"), reason: "Forgot to clock out" });
    await correctAttendance(w.actors.MANAGER, d.id, { clockIn: istToUtc("2026-10-12", "10:00"), reason: "Was at the desk on time" });
    await correctAttendance(w.actors.MANAGER, d.id, { clockIn: istToUtc("2026-10-12", "10:02"), reason: "CCTV says 10:02" });
    const a = await prisma.attendance.findUniqueOrThrow({ where: { id: d.id } });
    expect(a.originalClockIn!.getTime()).toBe(istToUtc("2026-10-12", "10:15").getTime()); // the first original stays
    expect(a.correctionReason).toBe("CCTV says 10:02");
    expect(await prisma.auditLog.count({ where: { action: "attendance.correct", entityId: d.id } })).toBe(2);
    const r = await listView(w.actors.MANAGER, "attendance", { range: "TODAY", flag: "edited" });
    expect(r.total).toBe(2);
    expect(r.rows.find((x) => x.id === b.id)!.worked_min).toBe(235);
    expect(r.rows.find((x) => x.id === d.id)!.late_min).toBe(0);
    const managerAtt = await (async () => {
      at("2026-10-12", "19:05");
      return clockIn(w.actors.MANAGER);
    })();
    await expect(correctAttendance(w.actors.MANAGER, managerAtt.id, { clockIn: istToUtc("2026-10-12", "19:00"), reason: "own" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(correctAttendance(w.actors.OWNER, managerAtt.id, { clockIn: istToUtc("2026-10-12", "19:10"), reason: "future" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("AT-6: per-employee summary for a period with CSV; Accountant reads, front desk cannot", async () => {
    await day();
    const r = await listView(w.actors.ACCOUNTANT, "attendance-summary", { range: "TODAY" });
    const desk = r.rows.find((x) => x.name === "Farah Desk")!;
    expect([desk.days_worked, desk.worked_min, desk.scheduled_min, desk.late_count, desk.late_min]).toEqual([1, 510, 480, 1, 15]);
    expect(r.rows.find((x) => x.name === "Bina Bar")!.worked_min).toBe(0); // still clocked in: nothing worked yet
    const csv = await listExport(w.actors.ACCOUNTANT, "attendance-summary", { range: "TODAY" });
    expect(csv.split("\n")[0]).toBe("Employee,Role,Days worked,Clock-ins,Worked (min),Scheduled (min),Late arrivals,Late (min),Left early,Overtime (min),Missing clock-outs,Edited records,Approved leave days");
    expect(csv).toMatch(/Farah Desk,FRONT_DESK,1,1,510,480,1,15,0,0,0,0,0/);
    await expect(listView(w.actors.FRONT_DESK, "attendance-summary", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v3 §4.1/§4.2 — staff directory and employee page", () => {
  it("shows who is in now, today's shift, week hours, late arrivals, leave left and open drawers", async () => {
    await assignShift(w.actors.MANAGER, { employeeId: w.actors.FRONT_DESK.employeeId!, date: "2026-10-12", startTime: "10:00", endTime: "18:00", area: "FRONT_DESK" });
    await assignShift(w.actors.MANAGER, { employeeId: w.actors.BAR_STAFF.employeeId!, date: "2026-10-12", startTime: "10:00", endTime: "14:00", area: "BAR" });
    const lr = await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-12", endDate: "2026-10-13", reason: "festival" });
    await decideLeave(w.actors.MANAGER, lr.id, "APPROVED");
    at("2026-10-12", "10:20");
    await clockIn(w.actors.FRONT_DESK);
    let r = await listView(w.actors.MANAGER, "employees", {});
    expect(r.query.status).toBe("ACTIVE,ON_LEAVE");
    const desk = r.rows.find((x) => x.name === "Farah Desk")!;
    expect([desk.presence, desk.today_shift, desk.late_month, desk.week_scheduled_min]).toEqual(["IN", "10:00–18:00", 1, 480]);
    expect(r.rows.find((x) => x.name === "Bina Bar")!.presence).toBe("DUE");
    const shop = r.rows.find((x) => x.name === "Sameer Shop")!;
    expect([shop.status, shop.casual_left]).toEqual(["ON_LEAVE", 10]);
    expect(r.summary.find((s) => s.key === "in")!.value).toBe(1);
    expect(r.summary.find((s) => s.key === "due")!.value).toBe(1);
    // The world opens a drawer for the counter staff; the directory shows it with the cash expected in it.
    const open = await prisma.cashDrawerSession.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId, closedAt: null } });
    r = await listView(w.actors.MANAGER, "employees", { drawer: "yes", q: "Farah" });
    expect(r.rows.map((x) => [x.name, x.drawer_area, x.drawer_expected])).toEqual([["Farah Desk", open.area, open.openingFloat]]);
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: open.openingFloat });
    r = await listView(w.actors.MANAGER, "employees", { drawer: "yes", q: "Farah" });
    expect(r.total).toBe(0);
    r = await listView(w.actors.ACCOUNTANT, "employees", { presence: "DUE" });
    expect(r.rows.map((x) => x.name)).toEqual(["Bina Bar"]);
    await expect(listView(w.actors.FRONT_DESK, "employees", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("employee page: payslips only for Owner/Accountant, activity only for Owner/Manager, corrections only for managers", async () => {
    const id = w.actors.FRONT_DESK.employeeId!;
    const asManager = await employeeDetail(w.actors.MANAGER, id);
    expect(asManager.profile.name).toBe("Farah Desk");
    expect(asManager.payslips).toBeNull();
    expect(asManager.activity).not.toBeNull();
    expect(asManager.canCorrect).toBe(true);
    const asAccountant = await employeeDetail(w.actors.ACCOUNTANT, id);
    expect(asAccountant.payslips).toEqual([]);
    expect(asAccountant.activity).toBeNull();
    expect(asAccountant.canCorrect).toBe(false);
    expect((await employeeDetail(w.actors.MANAGER, w.actors.MANAGER.employeeId!)).canCorrect).toBe(false);
    await expect(employeeDetail(w.actors.BAR_STAFF, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
