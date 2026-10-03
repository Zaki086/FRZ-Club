// Staff: shifts roster, attendance (clock in/out, cash close), leave (plan §5.13 ST-1…ST-5, BR-10; R-32, R-43, R-47; E-15).
import type { LeaveType, Prisma, ShiftArea } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, dateRangeInclusive, dbDate, fmtDate, fromDbDate, istDate, istToUtc, isValidDateStr, timeToMinutes } from "@/lib/time";
import { pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, SYSTEM, type Actor, type UserActor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { attendanceLog } from "./attendance";
import { notify } from "./notifications";
import { getSettings } from "./settings";

function employeeOf(actor: Actor): string {
  if (actor.kind !== "USER" || !actor.employeeId) throw new DomainError("FORBIDDEN", "Only staff members have shifts and attendance.");
  return actor.employeeId;
}

// ───────────── attendance & cash drawer (ST-3, BR-10, E-15) ─────────────

export const clockInSchema = z.object({ openingFloat: z.number().int().min(0).default(0) });

export async function clockIn(actor: Actor, raw: z.input<typeof clockInSchema> = {}, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = clockInSchema.parse(raw);
  const employeeId = employeeOf(actor);
  return withTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`;
    const open = await tx.attendance.findFirst({ where: { employeeId, clockOut: null } });
    if (open) throw new DomainError("VALIDATION_FAILED", `You are already clocked in since ${fmtDate(istDate(open.clockIn))} ${hhmm(open.clockIn)}.`);
    const now = clock.now();
    const shift = await tx.shift.findFirst({ where: { employeeId, status: "ASSIGNED", startAt: { lte: new Date(now.getTime() + 60 * 60_000) }, endAt: { gt: now } }, orderBy: { startAt: "asc" } });
    const a = await tx.attendance.create({ data: { employeeId, shiftId: shift?.id ?? null, clockIn: now, openingFloat: input.openingFloat } });
    await audit(tx, actor, "attendance.clock_in", "attendance", a.id, { after: { shiftId: shift?.id ?? null, openingFloat: input.openingFloat } });
    return a;
  }, outer);
}

/** Cash expected = opening float + cash taken − cash refunded on this attendance ("shift"). */
async function expectedCash(tx: Tx | typeof prisma, attendanceId: string, openingFloat: number) {
  const rows = await tx.payment.groupBy({ by: ["type"], where: { shiftId: attendanceId, method: "CASH", status: "SUCCEEDED" }, _sum: { amount: true } });
  const inCash = rows.find((r) => r.type === "PAYMENT")?._sum.amount ?? 0;
  const outCash = rows.find((r) => r.type === "REFUND")?._sum.amount ?? 0;
  return openingFloat + inCash - outCash;
}

export const clockOutSchema = z.object({ cashCounted: z.number().int().min(0).optional() });

/** Clock out; when a cash count is entered the variance (counted − expected) is stored (E-15). */
export async function clockOut(actor: Actor, raw: z.input<typeof clockOutSchema> = {}, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = clockOutSchema.parse(raw);
  const employeeId = employeeOf(actor);
  return withTx(async (tx) => {
    const open = await tx.attendance.findFirst({ where: { employeeId, clockOut: null }, orderBy: { clockIn: "desc" } });
    if (!open) throw new DomainError("VALIDATION_FAILED", "You are not clocked in.");
    const expected = await expectedCash(tx, open.id, open.openingFloat);
    // Cash is counted on the cash drawer (completion pass 8.4); a shift only counts it when it was opened with a float.
    const handledCash = open.openingFloat > 0;
    if (handledCash && input.cashCounted === undefined) {
      throw new DomainError("VALIDATION_FAILED", `Count the cash drawer before clocking out (expected ${formatINR(expected)}).`, { expected });
    }
    const a = await tx.attendance.update({
      where: { id: open.id },
      data: {
        clockOut: clock.now(),
        cashExpected: handledCash ? expected : null,
        cashCounted: handledCash ? input.cashCounted! : null,
        variance: handledCash ? input.cashCounted! - expected : null,
      },
    });
    await audit(tx, actor, "attendance.clock_out", "attendance", a.id, { after: { cashExpected: a.cashExpected, cashCounted: a.cashCounted, variance: a.variance } });
    if (a.variance) {
      await notify(tx, {
        roles: ["MANAGER", "OWNER"], type: "CASH_VARIANCE", title: `Cash variance ${formatINR(a.variance)}`,
        body: `${actor.kind === "USER" ? actor.name : "Staff"} closed the drawer: expected ${formatINR(a.cashExpected!)}, counted ${formatINR(a.cashCounted!)}.`,
        link: "/app/staff/roster?tab=attendance", dedupeKey: `cash-variance:${a.id}`,
      });
    }
    return a;
  }, outer);
}

export async function myStatus(actor: Actor) {
  assertCan(actor, "staff.self");
  const employeeId = employeeOf(actor);
  const s = await getSettings();
  const open = await prisma.attendance.findFirst({ where: { employeeId, clockOut: null }, orderBy: { clockIn: "desc" } });
  const today = istDate(clock.now());
  const [shifts, leave, attendance] = await Promise.all([
    prisma.shift.findMany({ where: { employeeId, date: { gte: dbDate(addDays(today, -1)), lte: dbDate(addDays(today, 14)) } }, orderBy: { startAt: "asc" } }),
    prisma.leaveRequest.findMany({ where: { employeeId }, orderBy: { startDate: "desc" }, take: 30 }),
    prisma.attendance.findMany({ where: { employeeId }, orderBy: { clockIn: "desc" }, take: 20 }),
  ]);
  const year = today.slice(0, 4);
  const used = await leaveUsed(prisma, employeeId, year);
  return {
    clockedIn: open ? { id: open.id, since: open.clockIn, openingFloat: open.openingFloat, cashExpected: await expectedCash(prisma, open.id, open.openingFloat) } : null,
    shifts: shifts.map((x) => ({ ...x, date: fromDbDate(x.date) })),
    leave: leave.map((l) => ({ ...l, startDate: fromDbDate(l.startDate), endDate: fromDbDate(l.endDate) })),
    attendance,
    today,
    allowance: { CASUAL: { total: s.leave_allowance.CASUAL, used: used.CASUAL }, SICK: { total: s.leave_allowance.SICK, used: used.SICK } },
  };
}

export async function listAttendance(actor: Actor, opts: { from?: string; to?: string } = {}) {
  assertCan(actor, "roster.manage");
  const today = istDate(clock.now());
  const from = opts.from && isValidDateStr(opts.from) ? opts.from : addDays(today, -7);
  const to = opts.to && isValidDateStr(opts.to) ? opts.to : today;
  const rows = await prisma.attendance.findMany({ where: { clockIn: { gte: istToUtc(from), lt: istToUtc(addDays(to, 1)) } }, orderBy: { clockIn: "desc" } });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, include: { user: true } });
  return rows.map((r) => ({ ...r, name: emps.find((e) => e.id === r.employeeId)?.user.name ?? "?", role: emps.find((e) => e.id === r.employeeId)?.user.role ?? null }));
}

// ───────────── roster (ST-2, R-47) ─────────────

export const shiftSchema = z.object({
  employeeId: z.string().min(1),
  date: z.string().refine(isValidDateStr),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  area: z.enum(["FRONT_DESK", "BAR", "KITCHEN", "SHOP", "COURTS"]),
});

/** ST-2: no overlapping shifts per employee (exclusion constraint) and none during approved leave. */
export async function assignShift(actor: Actor, raw: z.infer<typeof shiftSchema>, outer?: Tx) {
  assertCan(actor, "roster.manage");
  const input = shiftSchema.parse(raw);
  return withTx(async (tx) => {
    const emp = await tx.employee.findUnique({ where: { id: input.employeeId }, include: { user: true } });
    if (!emp || !emp.active) throw new DomainError("NOT_FOUND", "Employee was not found.");
    const start = istToUtc(input.date, input.startTime);
    let end = istToUtc(input.date, input.endTime);
    if (timeToMinutes(input.endTime) <= timeToMinutes(input.startTime)) end = istToUtc(addDays(input.date, 1), input.endTime); // overnight
    const leave = await tx.leaveRequest.findFirst({
      where: { employeeId: emp.id, status: "APPROVED", startDate: { lte: dbDate(input.date) }, endDate: { gte: dbDate(input.date) } },
    });
    if (leave) throw new DomainError("LEAVE_CONFLICT", `${emp.user.name} is on approved ${leave.type.toLowerCase()} leave ${fmtDate(fromDbDate(leave.startDate))} – ${fmtDate(fromDbDate(leave.endDate))}.`);
    await tx.$executeRawUnsafe("SAVEPOINT shift_insert");
    try {
      const shift = await tx.shift.create({ data: { employeeId: emp.id, date: dbDate(input.date), startAt: start, endAt: end, area: input.area as ShiftArea, createdBy: actorId(actor) } });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT shift_insert");
      await audit(tx, actor, "shift.assign", "shift", shift.id, { after: { employee: emp.user.name, date: input.date, start: input.startTime, end: input.endTime, area: input.area } });
      return shift;
    } catch (e) {
      if (pgErrorCode(e) === "23P01") {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT shift_insert");
        const other = await tx.$queryRaw<{ start_at: Date; end_at: Date; area: string }[]>`
          SELECT start_at, end_at, area::text FROM shifts WHERE employee_id = ${emp.id} AND status = 'ASSIGNED'
             AND period && tstzrange(${start}, ${end}, '[)') LIMIT 1`;
        const o = other[0];
        throw new DomainError("SHIFT_OVERLAP", `${emp.user.name} already has a ${o?.area.toLowerCase().replace("_", " ") ?? ""} shift ${o ? `on ${fmtDate(istDate(o.start_at))} ${hhmm(o.start_at)}–${hhmm(o.end_at)}` : "at that time"}.`);
      }
      throw e;
    }
  }, outer);
}

/** Fill an OPEN shift (e.g. after a leave approval unassigned it). Same rules as assigning (ST-2). */
export async function fillShift(actor: Actor, shiftId: string, employeeId: string) {
  assertCan(actor, "roster.manage");
  return withTx(async (tx) => {
    const s = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!s) throw new DomainError("NOT_FOUND", "Shift was not found.");
    if (s.status !== "OPEN") throw new DomainError("VALIDATION_FAILED", "Only open shifts can be filled.");
    const emp = await tx.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
    if (!emp || !emp.active) throw new DomainError("NOT_FOUND", "Employee was not found.");
    const leave = await tx.leaveRequest.findFirst({ where: { employeeId, status: "APPROVED", startDate: { lte: s.date }, endDate: { gte: s.date } } });
    if (leave) throw new DomainError("LEAVE_CONFLICT", `${emp.user.name} is on approved leave that day.`);
    await tx.$executeRawUnsafe("SAVEPOINT shift_fill");
    try {
      const updated = await tx.shift.update({ where: { id: s.id }, data: { employeeId, status: "ASSIGNED" } });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT shift_fill");
      await audit(tx, actor, "shift.fill", "shift", s.id, { before: { status: "OPEN" }, after: { employee: emp.user.name } });
      return updated;
    } catch (e) {
      if (pgErrorCode(e) === "23P01") {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT shift_fill");
        throw new DomainError("SHIFT_OVERLAP", `${emp.user.name} already has a shift that overlaps ${hhmm(s.startAt)}–${hhmm(s.endAt)} on ${fmtDate(fromDbDate(s.date))}.`);
      }
      throw e;
    }
  });
}

function hhmm(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.toISOString().slice(11, 16);
}

export async function removeShift(actor: Actor, shiftId: string) {
  assertCan(actor, "roster.manage");
  return withTx(async (tx) => {
    const s = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!s) throw new DomainError("NOT_FOUND", "Shift was not found.");
    // Never deleted: unassigned shifts stay visible as OPEN.
    const updated = await tx.shift.update({ where: { id: s.id }, data: { status: "OPEN", previousEmployeeId: s.employeeId, employeeId: null } });
    await audit(tx, actor, "shift.unassign", "shift", s.id, { before: { employeeId: s.employeeId }, after: { status: "OPEN" } });
    return updated;
  });
}

export async function listRoster(actor: Actor, opts: { from?: string; days?: number } = {}) {
  const today = istDate(clock.now());
  const from = opts.from && isValidDateStr(opts.from) ? opts.from : today;
  const to = addDays(from, Math.min(opts.days ?? 7, 31) - 1);
  const where: Prisma.ShiftWhereInput = { date: { gte: dbDate(from), lte: dbDate(to) } };
  if (!can(actor, "roster.manage")) {
    assertCan(actor, "roster.view_own");
    where.employeeId = employeeOf(actor);
  }
  const shifts = await prisma.shift.findMany({ where, orderBy: { startAt: "asc" } });
  const emps = await prisma.employee.findMany({ where: { active: true }, include: { user: true }, orderBy: { user: { name: "asc" } } });
  const leave = await prisma.leaveRequest.findMany({ where: { status: "APPROVED", endDate: { gte: dbDate(from) }, startDate: { lte: dbDate(to) } } });
  return {
    from, to, days: dateRangeInclusive(from, to),
    employees: (can(actor, "roster.manage") ? emps : emps.filter((e) => e.id === (actor as UserActor).employeeId)).map((e) => ({ id: e.id, name: e.user.name, role: e.user.role })),
    shifts: shifts.map((s) => ({ ...s, date: fromDbDate(s.date), start: hhmm(s.startAt), end: hhmm(s.endAt), name: emps.find((e) => e.id === (s.employeeId ?? s.previousEmployeeId))?.user.name ?? null })),
    leave: leave.map((l) => ({ employeeId: l.employeeId, startDate: fromDbDate(l.startDate), endDate: fromDbDate(l.endDate), type: l.type })),
  };
}

// ───────────── leave (ST-4, ST-5, R-43) ─────────────

async function leaveUsed(db: Tx | typeof prisma, employeeId: string, year: string) {
  const rows = await db.leaveRequest.findMany({
    where: { employeeId, status: { in: ["APPROVED", "PENDING"] }, startDate: { gte: dbDate(`${year}-01-01`), lte: dbDate(`${year}-12-31`) } },
  });
  return {
    CASUAL: rows.filter((r) => r.type === "CASUAL").reduce((a, r) => a + r.days, 0),
    SICK: rows.filter((r) => r.type === "SICK").reduce((a, r) => a + r.days, 0),
  };
}

export const leaveSchema = z.object({
  type: z.enum(["CASUAL", "SICK", "UNPAID"]),
  startDate: z.string().refine(isValidDateStr),
  endDate: z.string().refine(isValidDateStr),
  reason: z.string().trim().min(3).max(300),
});

/**
 * ST-5: beyond the yearly allowance a request must be UNPAID (LEAVE_BALANCE_EXCEEDED).
 * v3 LV-1: no request may start before today (IST); LV-2: end ≥ start and no overlap with own PENDING/APPROVED leave.
 */
export async function requestLeave(actor: Actor, raw: z.infer<typeof leaveSchema>, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = leaveSchema.parse(raw);
  const employeeId = employeeOf(actor);
  return withTx(async (tx) => {
    const today = istDate(clock.now());
    if (input.startDate < today) throw new DomainError("LEAVE_DATE_IN_PAST", `Leave can't start in the past: today is ${fmtDate(today)}.`);
    if (input.endDate < input.startDate) throw new DomainError("VALIDATION_FAILED", "Leave must end on or after its start date.");
    if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) throw new DomainError("VALIDATION_FAILED", "Split leave that crosses a calendar year into two requests.");
    const days = dateRangeInclusive(input.startDate, input.endDate).length;
    const overlap = await tx.leaveRequest.findFirst({
      where: { employeeId, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: dbDate(input.endDate) }, endDate: { gte: dbDate(input.startDate) } },
    });
    if (overlap) throw new DomainError("LEAVE_OVERLAP", `You already have ${overlap.status.toLowerCase()} leave ${fmtDate(fromDbDate(overlap.startDate))} – ${fmtDate(fromDbDate(overlap.endDate))}.`);
    if (input.type !== "UNPAID") {
      const s = await getSettings(tx);
      const used = await leaveUsed(tx, employeeId, input.startDate.slice(0, 4));
      const allowance = s.leave_allowance[input.type];
      if (used[input.type] + days > allowance) {
        throw new DomainError(
          "LEAVE_BALANCE_EXCEEDED",
          `Only ${Math.max(0, allowance - used[input.type])} of ${allowance} ${input.type.toLowerCase()} days are left this year; ${days} requested. Request the extra days as unpaid leave.`,
          { remaining: Math.max(0, allowance - used[input.type]) },
        );
      }
    }
    const lr = await tx.leaveRequest.create({ data: { employeeId, type: input.type as LeaveType, startDate: dbDate(input.startDate), endDate: dbDate(input.endDate), days, reason: input.reason } });
    await audit(tx, actor, "leave.request", "leave_request", lr.id, { after: { type: input.type, from: input.startDate, to: input.endDate, days } });
    await notify(tx, {
      roles: ["MANAGER", "OWNER"], type: "LEAVE_REQUESTED", title: `Leave request: ${actor.kind === "USER" ? actor.name : ""}`,
      body: `${input.type.toLowerCase()} · ${fmtDate(input.startDate)} – ${fmtDate(input.endDate)} (${days} day${days > 1 ? "s" : ""}) · ${input.reason}`,
      link: "/app/staff/leave", dedupeKey: `leave-requested:${lr.id}`,
    });
    return lr;
  }, outer);
}

/**
 * ST-4: approving unassigns overlapping shifts (they become OPEN) and asks the manager to refill them.
 * v3 LV-3: approval re-validates — a request whose start date has passed can't be approved (the daily job expires
 * it), nor one that now overlaps the employee's approved leave. Rejecting is always possible.
 */
export async function decideLeave(actor: Actor, leaveId: string, decision: "APPROVED" | "REJECTED", note?: string, outer?: Tx) {
  assertCan(actor, "leave.approve");
  return withTx(async (tx) => {
    const lr = await tx.leaveRequest.findUnique({ where: { id: leaveId } });
    if (!lr) throw new DomainError("NOT_FOUND", "Leave request was not found.");
    if (lr.status !== "PENDING") throw new DomainError("VALIDATION_FAILED", `This request was already ${lr.status.toLowerCase()}.`);
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: lr.employeeId }, include: { user: true } });
    if (actor.kind === "USER" && actor.employeeId === lr.employeeId) throw new DomainError("FORBIDDEN", "Not allowed: you can't decide your own leave.");
    if (decision === "APPROVED") {
      const today = istDate(clock.now());
      if (fromDbDate(lr.startDate) < today) throw new DomainError("LEAVE_DATE_IN_PAST", `This leave started on ${fmtDate(fromDbDate(lr.startDate))}, which has passed; it can't be approved now. Reject it or ask for a new request.`);
      const overlap = await tx.leaveRequest.findFirst({ where: { employeeId: lr.employeeId, id: { not: lr.id }, status: "APPROVED", startDate: { lte: lr.endDate }, endDate: { gte: lr.startDate } } });
      if (overlap) throw new DomainError("LEAVE_OVERLAP", `${emp.user.name} already has approved leave ${fmtDate(fromDbDate(overlap.startDate))} – ${fmtDate(fromDbDate(overlap.endDate))}.`);
    }
    await tx.leaveRequest.update({ where: { id: lr.id }, data: { status: decision, decidedBy: actorId(actor), decidedAt: clock.now(), decisionNote: note ?? null } });
    let unassigned = 0;
    if (decision === "APPROVED") {
      const shifts = await tx.shift.findMany({
        where: { employeeId: lr.employeeId, status: "ASSIGNED", date: { gte: lr.startDate, lte: lr.endDate } },
      });
      for (const s of shifts) {
        await tx.shift.update({ where: { id: s.id }, data: { status: "OPEN", previousEmployeeId: s.employeeId, employeeId: null } });
        unassigned++;
      }
      if (unassigned) {
        await notify(tx, {
          roles: ["MANAGER"], type: "SHIFT_UNASSIGNED", title: `${unassigned} shift${unassigned > 1 ? "s" : ""} need cover`,
          body: `${emp.user.name} is on leave ${fmtDate(fromDbDate(lr.startDate))} – ${fmtDate(fromDbDate(lr.endDate))}; their shifts are now open.`,
          link: "/app/staff/roster", dedupeKey: `shift-unassigned:${lr.id}`,
        });
      }
    }
    await audit(tx, actor, `leave.${decision.toLowerCase()}`, "leave_request", lr.id, { before: { status: "PENDING" }, after: { status: decision, unassignedShifts: unassigned }, reason: note ?? null });
    await notify(tx, {
      userIds: [emp.userId], type: "LEAVE_DECIDED", title: `Leave ${decision.toLowerCase()}`,
      body: `${lr.type.toLowerCase()} leave ${fmtDate(fromDbDate(lr.startDate))} – ${fmtDate(fromDbDate(lr.endDate))}${note ? ` · ${note}` : ""}`,
      link: "/app/staff/me", dedupeKey: `leave-decided:${lr.id}`,
    });
    return { leaveId: lr.id, status: decision, unassignedShifts: unassigned };
  }, outer);
}

/** v3 LV-3 (daily job): PENDING requests whose start date has passed become EXPIRED and the employee is told. */
export async function expireStaleLeave() {
  const today = istDate(clock.now());
  return withTx(async (tx) => {
    const stale = await tx.leaveRequest.findMany({ where: { status: "PENDING", startDate: { lt: dbDate(today) } } });
    for (const lr of stale) {
      const emp = await tx.employee.findUniqueOrThrow({ where: { id: lr.employeeId } });
      await tx.leaveRequest.update({ where: { id: lr.id }, data: { status: "EXPIRED", decidedAt: clock.now(), decisionNote: "Not decided before the start date" } });
      await audit(tx, SYSTEM, "leave.expired", "leave_request", lr.id, { before: { status: "PENDING" }, after: { status: "EXPIRED" } });
      await notify(tx, {
        userIds: [emp.userId], type: "LEAVE_DECIDED", title: "Leave request expired",
        body: `${lr.type.toLowerCase()} leave ${fmtDate(fromDbDate(lr.startDate))} – ${fmtDate(fromDbDate(lr.endDate))} wasn't decided before it started. Ask your manager or send a new request.`,
        link: "/app/staff/me", dedupeKey: `leave-expired:${lr.id}`,
      });
    }
    return { expired: stale.length };
  });
}

export async function listLeave(actor: Actor, opts: { status?: string } = {}) {
  assertCan(actor, "leave.approve");
  const rows = await prisma.leaveRequest.findMany({
    where: { status: opts.status ? (opts.status as "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED") : undefined },
    orderBy: [{ status: "asc" }, { startDate: "asc" }],
    take: 300,
  });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, include: { user: true } });
  return rows.map((r) => ({ ...r, startDate: fromDbDate(r.startDate), endDate: fromDbDate(r.endDate), name: emps.find((e) => e.id === r.employeeId)?.user.name ?? "?" }));
}

export async function listEmployees(actor: Actor) {
  assertCan(actor, "roster.manage");
  const emps = await prisma.employee.findMany({ where: { active: true }, include: { user: true }, orderBy: { user: { name: "asc" } } });
  return emps.map((e) => ({ id: e.id, name: e.user.name, role: e.user.role, phone: e.user.phone }));
}

/**
 * v3 §4.2 employee page: profile, roster (30 days back and ahead), attendance log with AT-1…AT-5 numbers, cash drawer
 * sessions with variances, leave history and balance, payslips (Owner/Accountant) and recent activity (Owner/Manager).
 */
export async function employeeDetail(actor: Actor, employeeId: string) {
  assertCan(actor, "staff.directory");
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
  if (!emp) throw new DomainError("NOT_FOUND", "Employee was not found.");
  const s = await getSettings();
  const today = istDate(clock.now());
  const from = addDays(today, -30);
  const to = addDays(today, 30);
  const [shifts, attendance, drawers, leave, used, payslips, activity] = await Promise.all([
    prisma.shift.findMany({ where: { OR: [{ employeeId }, { previousEmployeeId: employeeId }], date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: { startAt: "asc" } }),
    attendanceLog(employeeId, istToUtc(addDays(today, -60)), istToUtc(addDays(today, 1))),
    prisma.cashDrawerSession.findMany({ where: { userId: emp.userId }, orderBy: { openedAt: "desc" }, take: 30 }),
    prisma.leaveRequest.findMany({ where: { employeeId }, orderBy: { startDate: "desc" }, take: 50 }),
    leaveUsed(prisma, employeeId, today.slice(0, 4)),
    can(actor, "payroll") ? prisma.payslip.findMany({ where: { employeeId }, include: { run: true }, orderBy: { createdAt: "desc" }, take: 24 }) : Promise.resolve(null),
    can(actor, "staff.activity") ? prisma.auditLog.findMany({ where: { actorId: emp.userId }, orderBy: { at: "desc" }, take: 50 }) : Promise.resolve(null),
  ]);
  return {
    profile: {
      id: emp.id, userId: emp.userId, name: emp.user.name, role: emp.user.role, phone: emp.user.phone, email: emp.user.email,
      joinDate: fromDbDate(emp.joinDate), active: emp.active && emp.user.active, lastLoginAt: emp.user.lastLoginAt,
    },
    today,
    canCorrect: can(actor, "attendance.correct") && !(actor.kind === "USER" && actor.employeeId === employeeId),
    rules: { lateGraceMinutes: s.late_grace_minutes, overtimeThresholdMinutes: s.overtime_threshold_minutes, missingClockoutHours: s.missing_clockout_hours },
    shifts: shifts.map((x) => ({ id: x.id, date: fromDbDate(x.date), startAt: x.startAt, endAt: x.endAt, area: x.area, status: x.employeeId === employeeId ? x.status : "REASSIGNED" })),
    attendance,
    drawers: drawers.map((d) => ({ id: d.id, area: d.area, openedAt: d.openedAt, closedAt: d.closedAt, openingFloat: d.openingFloat, cashExpected: d.cashExpected, cashCounted: d.cashCounted, variance: d.variance })),
    leave: leave.map((l) => ({ id: l.id, type: l.type, startDate: fromDbDate(l.startDate), endDate: fromDbDate(l.endDate), days: l.days, status: l.status, reason: l.reason, decisionNote: l.decisionNote })),
    allowance: { CASUAL: { total: s.leave_allowance.CASUAL, used: used.CASUAL }, SICK: { total: s.leave_allowance.SICK, used: used.SICK } },
    payslips: payslips?.map((p) => ({ id: p.id, month: p.run.month, runStatus: p.run.status, gross: p.gross, unpaidDays: p.unpaidDays, deductions: p.deductions, net: p.net, paidAt: p.paidAt })) ?? null,
    activity: activity?.map((a) => ({ id: a.id, at: a.at, action: a.action, entity: a.entity, entityId: a.entityId, reason: a.reason })) ?? null,
  };
}
