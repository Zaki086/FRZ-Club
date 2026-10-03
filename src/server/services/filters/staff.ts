// v3 §4: staff directory, attendance log and per-employee attendance summary (AT-6) lists.
import { Prisma } from "@prisma/client";
import { addDays, istDayRange, monthStart, weekStart } from "@/lib/time";
import { ATTENDANCE_ROWS_SQL } from "../attendance";
import type { ListDef } from "./core";

const ROLE_OPTIONS = [
  { value: "OWNER", label: "Owner" }, { value: "MANAGER", label: "Manager" }, { value: "FRONT_DESK", label: "Front desk" },
  { value: "SHOP_STAFF", label: "Shop" }, { value: "BAR_STAFF", label: "Bar" }, { value: "KITCHEN", label: "Kitchen" }, { value: "ACCOUNTANT", label: "Accountant" },
];
const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const att = Prisma.raw(ATTENDANCE_ROWS_SQL);

/** §4.1 staff directory: who is here now, today's shift, this week's hours, late arrivals, missing clock-outs, leave, drawer. */
export const employeesList: ListDef = {
  name: "employees",
  title: "Staff",
  view: ["staff.directory"],
  exportCaps: ["staff.directory"],
  base: (ctx) => {
    const [dayStart, dayEnd] = istDayRange(ctx.today);
    const week = istDayRange(weekStart(ctx.today))[0];
    const weekEnd = istDayRange(addDays(weekStart(ctx.today), 6))[1];
    const month = istDayRange(monthStart(ctx.today))[0];
    const yearStart = `${ctx.today.slice(0, 4)}-01-01`;
    const yearEnd = `${ctx.today.slice(0, 4)}-12-31`;
    return Prisma.sql`
      WITH att AS (${att})
      SELECT e.id, u.id AS user_id, u.name, u.phone, u.role::text AS role,
        CASE WHEN NOT (u.active AND e.active) THEN 'INACTIVE' WHEN lv.on_leave THEN 'ON_LEAVE' ELSE 'ACTIVE' END AS status,
        CASE WHEN oa.clock_in IS NOT NULL THEN 'IN' WHEN sn.id IS NOT NULL THEN 'DUE' ELSE 'OFF' END AS presence,
        oa.clock_in AS clocked_in_since,
        td.shifts AS today_shift,
        COALESCE(wk.worked_min, 0) AS week_worked_min, COALESCE(ws.scheduled_min, 0) AS week_scheduled_min,
        COALESCE(mo.late, 0) AS late_month, COALESCE(mo.missing, 0) AS missing_clockouts,
        GREATEST(0, COALESCE((SELECT (value->>'CASUAL')::int FROM settings WHERE key = 'leave_allowance'), 0) - COALESCE(lu.casual, 0)) AS casual_left,
        GREATEST(0, COALESCE((SELECT (value->>'SICK')::int FROM settings WHERE key = 'leave_allowance'), 0) - COALESCE(lu.sick, 0)) AS sick_left,
        dr.id IS NOT NULL AS drawer_open, dr.area AS drawer_area, dr.expected AS drawer_expected
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN LATERAL (SELECT TRUE AS on_leave FROM leave_requests l WHERE l.employee_id = e.id AND l.status = 'APPROVED'
                           AND l.start_date <= ${ctx.today}::date AND l.end_date >= ${ctx.today}::date LIMIT 1) lv ON TRUE
      LEFT JOIN LATERAL (SELECT a.clock_in FROM attendance a WHERE a.employee_id = e.id AND a.clock_out IS NULL ORDER BY a.clock_in DESC LIMIT 1) oa ON TRUE
      LEFT JOIN LATERAL (SELECT s.id FROM shifts s WHERE s.employee_id = e.id AND s.status = 'ASSIGNED' AND s.start_at <= app_now() AND s.end_at > app_now() LIMIT 1) sn ON TRUE
      LEFT JOIN LATERAL (SELECT string_agg(to_char(s.start_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') || '–' || to_char(s.end_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI'), ', ' ORDER BY s.start_at) AS shifts
                           FROM shifts s WHERE s.employee_id = e.id AND s.status = 'ASSIGNED' AND s.start_at >= ${dayStart} AND s.start_at < ${dayEnd}) td ON TRUE
      LEFT JOIN LATERAL (SELECT sum(x.worked_min)::int AS worked_min FROM att x WHERE x.employee_id = e.id AND x.clock_in >= ${week}) wk ON TRUE
      LEFT JOIN LATERAL (SELECT sum(floor(extract(epoch FROM s.end_at - s.start_at) / 60))::int AS scheduled_min FROM shifts s
                          WHERE s.employee_id = e.id AND s.status = 'ASSIGNED' AND s.start_at >= ${week} AND s.start_at < ${weekEnd}) ws ON TRUE
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE x.late_min > 0)::int AS late, count(*) FILTER (WHERE x.missing)::int AS missing
                           FROM att x WHERE x.employee_id = e.id AND x.clock_in >= ${month}) mo ON TRUE
      LEFT JOIN LATERAL (SELECT sum(l.days) FILTER (WHERE l.type = 'CASUAL')::int AS casual, sum(l.days) FILTER (WHERE l.type = 'SICK')::int AS sick
                           FROM leave_requests l WHERE l.employee_id = e.id AND l.status IN ('APPROVED', 'PENDING')
                            AND l.start_date >= ${yearStart}::date AND l.start_date <= ${yearEnd}::date) lu ON TRUE
      LEFT JOIN LATERAL (SELECT d.id, d.area, d.opening_float
                                + COALESCE((SELECT sum(CASE WHEN p.type = 'PAYMENT' THEN p.amount ELSE -p.amount END) FROM payments p
                                             WHERE p.drawer_session_id = d.id AND p.method = 'CASH' AND p.status = 'SUCCEEDED'), 0) AS expected
                           FROM cash_drawer_sessions d WHERE d.user_id = u.id AND d.closed_at IS NULL ORDER BY d.opened_at DESC LIMIT 1) dr ON TRUE`;
  },
  search: ["b.name", "b.phone"],
  facets: [
    { key: "role", label: "Role", expr: "b.role", options: ROLE_OPTIONS },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "ACTIVE", label: "Active" }, { value: "ON_LEAVE", label: "On leave today" }, { value: "INACTIVE", label: "Inactive" }] },
    { key: "presence", label: "Now", expr: "b.presence", options: [{ value: "IN", label: "Clocked in" }, { value: "DUE", label: "On shift, not clocked in" }, { value: "OFF", label: "Off" }] },
    { key: "late", label: "Late this month", expr: "CASE WHEN b.late_month > 0 THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "missing", label: "Missing clock-outs", expr: "CASE WHEN b.missing_clockouts > 0 THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "drawer", label: "Cash drawer open", expr: "CASE WHEN b.drawer_open THEN 'yes' ELSE 'no' END", options: YES_NO },
  ],
  sorts: {
    name: { label: "Name", sql: "b.name ASC" },
    presence: { label: "Here now first", sql: "CASE b.presence WHEN 'IN' THEN 0 WHEN 'DUE' THEN 1 ELSE 2 END, b.name" },
    late: { label: "Most late arrivals", sql: "b.late_month DESC, b.name" },
    hours: { label: "Most hours this week", sql: "b.week_worked_min DESC, b.name" },
  },
  defaultSort: "presence",
  summary: [
    { key: "in", label: "Clocked in now", sql: "count(*) FILTER (WHERE b.presence = 'IN')", format: "count", apply: { presence: "IN" } },
    { key: "due", label: "On shift, not clocked in", sql: "count(*) FILTER (WHERE b.presence = 'DUE')", format: "count", apply: { presence: "DUE" } },
    { key: "leave", label: "On leave today", sql: "count(*) FILTER (WHERE b.status = 'ON_LEAVE')", format: "count", apply: { status: "ON_LEAVE" } },
    { key: "missing", label: "With missing clock-outs", sql: "count(*) FILTER (WHERE b.missing_clockouts > 0)", format: "count", apply: { missing: "yes" } },
  ],
  csv: [
    { key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "status", label: "Status" }, { key: "presence", label: "Now" },
    { key: "today_shift", label: "Today's shift" }, { key: "week_worked_min", label: "Worked this week (min)" }, { key: "week_scheduled_min", label: "Scheduled this week (min)" },
    { key: "late_month", label: "Late arrivals this month" }, { key: "missing_clockouts", label: "Missing clock-outs this month" },
    { key: "casual_left", label: "Casual leave left" }, { key: "sick_left", label: "Sick leave left" }, { key: "drawer_expected", label: "Open drawer expected (₹)", format: "money" },
  ],
  defaults: () => ({ status: "ACTIVE,ON_LEAVE" }),
};

const FLAG_EXPR = `ARRAY_REMOVE(ARRAY[CASE WHEN b.late_min > 0 THEN 'late' END, CASE WHEN b.early_min > 0 THEN 'early' END,
  CASE WHEN b.overtime_min > 0 THEN 'overtime' END, CASE WHEN b.missing THEN 'missing' END, CASE WHEN b.edited THEN 'edited' END,
  CASE WHEN b.shift_id IS NULL THEN 'unscheduled' END], NULL)`;

/** §4.2 / AT-1…AT-5: every clock-in with worked, late, early leave, overtime, missing and edited markers. */
export const attendanceList: ListDef = {
  name: "attendance",
  title: "Attendance",
  view: ["staff.directory"],
  exportCaps: ["staff.directory"],
  base: (ctx) => Prisma.sql`SELECT * FROM (${att}) x WHERE TRUE
    ${ctx.from ? Prisma.sql`AND x.clock_in >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND x.clock_in < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.name"],
  dateColumn: { expr: "b.clock_in", label: "Date", kind: "timestamp" },
  facets: [
    { key: "employee", label: "Employee", expr: "b.employee_id", labelsSql: "SELECT e.id AS value, u.name AS label FROM employees e JOIN users u ON u.id = e.user_id" },
    { key: "role", label: "Role", expr: "b.role", options: ROLE_OPTIONS },
    { key: "area", label: "Area", expr: "COALESCE(b.area, 'NONE')", options: [
      { value: "FRONT_DESK", label: "Front desk" }, { value: "BAR", label: "Bar" }, { value: "KITCHEN", label: "Kitchen" }, { value: "SHOP", label: "Shop" },
      { value: "COURTS", label: "Courts" }, { value: "NONE", label: "No shift" },
    ] },
    { key: "flag", label: "Flags", expr: FLAG_EXPR, multi: true, options: [
      { value: "late", label: "Late" }, { value: "early", label: "Left early" }, { value: "overtime", label: "Overtime" },
      { value: "missing", label: "Missing clock-out" }, { value: "edited", label: "Edited" }, { value: "unscheduled", label: "No shift" },
    ] },
    { key: "open", label: "Clocked out", expr: "CASE WHEN b.clock_out IS NULL THEN 'no' ELSE 'yes' END", options: YES_NO },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.clock_in DESC" },
    oldest: { label: "Oldest first", sql: "b.clock_in ASC" },
    name: { label: "Name", sql: "b.name ASC, b.clock_in DESC" },
    late: { label: "Most late", sql: "b.late_min DESC, b.clock_in DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "worked", label: "Hours worked", sql: "COALESCE(sum(b.worked_min), 0)", format: "minutes", apply: { open: "yes" } },
    { key: "late", label: "Late arrivals", sql: "count(*) FILTER (WHERE b.late_min > 0)", format: "count", apply: { flag: "late" } },
    { key: "overtime", label: "Overtime", sql: "count(*) FILTER (WHERE b.overtime_min > 0)", format: "count", apply: { flag: "overtime" } },
    { key: "missing", label: "Missing clock-outs", sql: "count(*) FILTER (WHERE b.missing)", format: "count", apply: { flag: "missing" } },
  ],
  csv: [
    { key: "name", label: "Employee" }, { key: "role", label: "Role" }, { key: "work_date", label: "Date", format: "date" },
    { key: "sched_start", label: "Scheduled start", format: "datetime" }, { key: "sched_end", label: "Scheduled end", format: "datetime" },
    { key: "clock_in", label: "Clock-in", format: "datetime" }, { key: "clock_out", label: "Clock-out", format: "datetime" },
    { key: "worked_min", label: "Worked (min)" }, { key: "late_min", label: "Late (min)" }, { key: "early_min", label: "Left early (min)" },
    { key: "overtime_min", label: "Overtime (min)" }, { key: "missing", label: "Missing clock-out" }, { key: "edited", label: "Edited" },
    { key: "correction_reason", label: "Correction reason" },
  ],
  defaults: () => ({ range: "THIS_WEEK" }),
};

/** AT-6: totals per employee for the chosen period (feeds payroll review; payroll formulas are unchanged). */
export const attendanceSummaryList: ListDef = {
  name: "attendance-summary",
  title: "Attendance summary",
  view: ["staff.directory"],
  exportCaps: ["staff.directory"],
  base: (ctx) => {
    const from = ctx.from ?? monthStart(ctx.today);
    const to = ctx.to ?? ctx.today;
    const [start] = istDayRange(from);
    const [, end] = istDayRange(to);
    return Prisma.sql`
      WITH att AS (SELECT * FROM (${att}) x WHERE x.clock_in >= ${start} AND x.clock_in < ${end})
      SELECT e.id, u.name, u.role::text AS role, (u.active AND e.active) AS active,
        count(a.id)::int AS sessions, count(DISTINCT a.work_date)::int AS days_worked,
        COALESCE(sum(a.worked_min), 0)::int AS worked_min,
        COALESCE((SELECT sum(floor(extract(epoch FROM s.end_at - s.start_at) / 60)) FROM shifts s
                   WHERE s.employee_id = e.id AND s.status = 'ASSIGNED' AND s.start_at >= ${start} AND s.start_at < ${end}), 0)::int AS scheduled_min,
        count(a.id) FILTER (WHERE a.late_min > 0)::int AS late_count, COALESCE(sum(a.late_min), 0)::int AS late_min,
        count(a.id) FILTER (WHERE a.early_min > 0)::int AS early_count,
        COALESCE(sum(a.overtime_min), 0)::int AS overtime_min,
        count(a.id) FILTER (WHERE a.missing)::int AS missing, count(a.id) FILTER (WHERE a.edited)::int AS edited,
        COALESCE((SELECT sum(LEAST(l.end_date, ${to}::date) - GREATEST(l.start_date, ${from}::date) + 1) FROM leave_requests l
                   WHERE l.employee_id = e.id AND l.status = 'APPROVED' AND l.start_date <= ${to}::date AND l.end_date >= ${from}::date), 0)::int AS leave_days
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN att a ON a.employee_id = e.id
      GROUP BY e.id, u.name, u.role, u.active, e.active`;
  },
  search: ["b.name"],
  dateColumn: { expr: "", label: "Period", kind: "base" },
  facets: [
    { key: "role", label: "Role", expr: "b.role", options: ROLE_OPTIONS },
    { key: "late", label: "Late arrivals", expr: "CASE WHEN b.late_count > 0 THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "missing", label: "Missing clock-outs", expr: "CASE WHEN b.missing > 0 THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "active", label: "Active", expr: "CASE WHEN b.active THEN 'yes' ELSE 'no' END", options: YES_NO },
  ],
  sorts: {
    name: { label: "Name", sql: "b.name ASC" },
    worked: { label: "Most hours", sql: "b.worked_min DESC, b.name" },
    late: { label: "Most late arrivals", sql: "b.late_count DESC, b.name" },
  },
  defaultSort: "name",
  summary: [
    { key: "worked", label: "Hours worked", sql: "COALESCE(sum(b.worked_min), 0)", format: "minutes", apply: {} },
    { key: "late", label: "Late arrivals", sql: "COALESCE(sum(b.late_count), 0)", format: "count", apply: { late: "yes" } },
    { key: "missing", label: "Missing clock-outs", sql: "COALESCE(sum(b.missing), 0)", format: "count", apply: { missing: "yes" } },
  ],
  csv: [
    { key: "name", label: "Employee" }, { key: "role", label: "Role" }, { key: "days_worked", label: "Days worked" }, { key: "sessions", label: "Clock-ins" },
    { key: "worked_min", label: "Worked (min)" }, { key: "scheduled_min", label: "Scheduled (min)" }, { key: "late_count", label: "Late arrivals" },
    { key: "late_min", label: "Late (min)" }, { key: "early_count", label: "Left early" }, { key: "overtime_min", label: "Overtime (min)" },
    { key: "missing", label: "Missing clock-outs" }, { key: "edited", label: "Edited records" }, { key: "leave_days", label: "Approved leave days" },
  ],
  defaults: () => ({ range: "THIS_MONTH", active: "yes" }),
};

