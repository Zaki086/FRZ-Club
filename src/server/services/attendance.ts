// v3 §4.3 attendance rules AT-1…AT-6. One SQL definition of an attendance row (worked, scheduled, late, early leave,
// overtime, missing clock-out) is shared by the staff directory, the attendance list, the per-employee summary and the
// employee page, so every screen shows the same numbers. There is no break tracking in this system, so there is no
// break column (absent, not zero).
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { fmtDateTime } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, SYSTEM, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { APPROVAL_HREF } from "./approval-links";
import { audit } from "./audit";
import { notify } from "./notifications";

const IST = "'Asia/Kolkata'";
const setting = (key: string, fallback: number) => `COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = '${key}'), ${fallback})`;
export const LATE_GRACE_SQL = setting("late_grace_minutes", 10);
export const OVERTIME_SQL = setting("overtime_threshold_minutes", 30);
export const MISSING_HOURS_SQL = setting("missing_clockout_hours", 4);
/** The club's closing time on the clock-in day: the expected end of a session clocked in without a rostered shift. */
const CLOSE_SQL = `(((a.clock_in AT TIME ZONE ${IST})::date + COALESCE((SELECT value->>'close' FROM settings WHERE key = 'opening_hours'), '22:00')::time) AT TIME ZONE ${IST})`;

/**
 * One row per attendance with the AT-1…AT-4 numbers (minutes). Rows: id, employee_id, user_id, name, role, work_date,
 * clock_in, clock_out, shift_id, sched_start, sched_end, area, worked_min, scheduled_min, late_min, early_min,
 * overtime_min, expected_end, missing, edited, original_clock_in, original_clock_out, correction_reason, corrected_by.
 */
export const ATTENDANCE_ROWS_SQL = `
  SELECT a.id, a.employee_id, u.id AS user_id, u.name, u.role::text AS role,
    (a.clock_in AT TIME ZONE ${IST})::date AS work_date,
    a.clock_in, a.clock_out, a.shift_id, s.start_at AS sched_start, s.end_at AS sched_end, s.area::text AS area,
    CASE WHEN a.clock_out IS NOT NULL THEN floor(extract(epoch FROM a.clock_out - a.clock_in) / 60)::int END AS worked_min,
    CASE WHEN s.id IS NOT NULL THEN floor(extract(epoch FROM s.end_at - s.start_at) / 60)::int END AS scheduled_min,
    CASE WHEN s.id IS NOT NULL AND a.clock_in > s.start_at + make_interval(mins => ${LATE_GRACE_SQL})
         THEN floor(extract(epoch FROM a.clock_in - s.start_at) / 60)::int ELSE 0 END AS late_min,
    CASE WHEN s.id IS NOT NULL AND a.clock_out IS NOT NULL AND a.clock_out < s.end_at
         THEN floor(extract(epoch FROM s.end_at - a.clock_out) / 60)::int ELSE 0 END AS early_min,
    CASE WHEN s.id IS NOT NULL AND a.clock_out IS NOT NULL
          AND extract(epoch FROM (a.clock_out - a.clock_in) - (s.end_at - s.start_at)) / 60 > ${OVERTIME_SQL}
         THEN floor(extract(epoch FROM (a.clock_out - a.clock_in) - (s.end_at - s.start_at)) / 60)::int ELSE 0 END AS overtime_min,
    COALESCE(s.end_at, ${CLOSE_SQL}) AS expected_end,
    (a.missing_flagged_at IS NOT NULL OR (a.clock_out IS NULL AND app_now() > COALESCE(s.end_at, ${CLOSE_SQL}) + make_interval(hours => ${MISSING_HOURS_SQL}))) AS missing,
    a.corrected_at IS NOT NULL AS edited, a.original_clock_in, a.original_clock_out, a.correction_reason, cu.name AS corrected_by,
    a.variance
  FROM attendance a
  JOIN employees e ON e.id = a.employee_id
  JOIN users u ON u.id = e.user_id
  LEFT JOIN shifts s ON s.id = a.shift_id
  LEFT JOIN users cu ON cu.id = a.corrected_by`;

export { hmm } from "@/lib/duration";

/**
 * AT-4 (frequent job): an attendance still open `missing_clockout_hours` after its shift end (or after closing time
 * when there was no shift) is flagged once and the Manager is told. It is never closed automatically.
 */
export async function flagMissingClockouts() {
  return withTx(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; employee_id: string; name: string; clock_in: Date; expected_end: Date }[]>(Prisma.sql`
      SELECT x.id, x.employee_id, x.name, x.clock_in, x.expected_end FROM (${Prisma.raw(ATTENDANCE_ROWS_SQL)}) x
        JOIN attendance a ON a.id = x.id
       WHERE a.clock_out IS NULL AND a.missing_flagged_at IS NULL AND x.missing
       FOR UPDATE OF a`);
    for (const r of rows) {
      await tx.attendance.update({ where: { id: r.id }, data: { missingFlaggedAt: clock.now() } });
      await audit(tx, SYSTEM, "attendance.missing_clock_out", "attendance", r.id, { after: { flagged: true } });
      await notify(tx, {
        roles: ["MANAGER"], type: "MISSING_CLOCK_OUT", title: `Missing clock-out: ${r.name}`,
        body: `Clocked in ${fmtDateTime(r.clock_in)} and still not clocked out (expected by ${fmtDateTime(r.expected_end)}). Correct it with a reason on the attendance page.`,
        link: APPROVAL_HREF.attendance(r.employee_id), dedupeKey: `missing-clock-out:${r.id}`, // v4 RN-4: same page as the approvals row
      });
    }
    return { flagged: rows.length };
  });
}

export const correctionSchema = z
  .object({
    clockIn: z.coerce.date().optional(),
    clockOut: z.coerce.date().optional(),
    reason: z.string().trim().min(3, "Give a reason for the correction (at least 3 characters).").max(300),
  })
  .refine((v) => v.clockIn || v.clockOut, "Change the clock-in, the clock-out or both.");

/**
 * AT-5: a Manager corrects a clock-in/out with a mandatory reason. The first original values are kept, the change is
 * audited, and every screen shows an "edited" marker. Nobody corrects their own attendance.
 */
export async function correctAttendance(actor: Actor, attendanceId: string, raw: z.input<typeof correctionSchema>, outer?: Tx) {
  assertCan(actor, "attendance.correct");
  const input = correctionSchema.parse(raw);
  return withTx(async (tx) => {
    const [a] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM attendance WHERE id = ${attendanceId} FOR UPDATE`;
    if (!a) throw new DomainError("NOT_FOUND", "Attendance record was not found.");
    const before = await tx.attendance.findUniqueOrThrow({ where: { id: attendanceId } });
    if (actor.kind === "USER" && actor.employeeId === before.employeeId) throw new DomainError("FORBIDDEN", "Not allowed: you can't correct your own attendance.");
    const clockIn = input.clockIn ?? before.clockIn;
    const clockOut = input.clockOut ?? before.clockOut;
    const now = clock.now();
    if (clockIn > now || (clockOut && clockOut > now)) throw new DomainError("VALIDATION_FAILED", "Times can't be in the future.");
    if (clockOut && clockOut < clockIn) throw new DomainError("VALIDATION_FAILED", "Clock-out must be after clock-in.");
    if (clockOut && clockOut.getTime() - clockIn.getTime() > 24 * 3_600_000) throw new DomainError("VALIDATION_FAILED", "A single attendance can't be longer than 24 hours.");
    const after = await tx.attendance.update({
      where: { id: attendanceId },
      data: {
        clockIn,
        clockOut,
        originalClockIn: before.originalClockIn ?? before.clockIn,
        originalClockOut: before.correctedAt ? before.originalClockOut : before.clockOut,
        correctedBy: actorId(actor),
        correctedAt: now,
        correctionReason: input.reason,
      },
    });
    await audit(tx, actor, "attendance.correct", "attendance", attendanceId, {
      before: { clockIn: before.clockIn, clockOut: before.clockOut },
      after: { clockIn: after.clockIn, clockOut: after.clockOut },
      reason: input.reason,
    });
    return after;
  }, outer);
}

/** Attendance rows (AT-1…AT-4 numbers) for one employee, newest first. */
export async function attendanceLog(employeeId: string, from: Date, to: Date) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.now', ${clock.now().toISOString()}, true)`;
    return tx.$queryRaw<AttendanceRow[]>(Prisma.sql`
      SELECT * FROM (${Prisma.raw(ATTENDANCE_ROWS_SQL)}) x WHERE x.employee_id = ${employeeId} AND x.clock_in >= ${from} AND x.clock_in < ${to} ORDER BY x.clock_in DESC`);
  });
}

export type AttendanceRow = {
  id: string; employee_id: string; user_id: string; name: string; role: string; work_date: Date; clock_in: Date; clock_out: Date | null;
  shift_id: string | null; sched_start: Date | null; sched_end: Date | null; area: string | null; worked_min: number | null;
  scheduled_min: number | null; late_min: number; early_min: number; overtime_min: number; expected_end: Date; missing: boolean;
  edited: boolean; original_clock_in: Date | null; original_clock_out: Date | null; correction_reason: string | null; corrected_by: string | null;
  variance: number | null;
};
