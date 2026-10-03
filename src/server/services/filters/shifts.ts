// v3 §3.2: the roster as a list — every shift with its day, hours, area and who is on it (open shifts need cover).
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const TODAY = "(app_now() AT TIME ZONE 'Asia/Kolkata')::date";

export const shiftsList: ListDef = {
  name: "shifts",
  title: "Shifts",
  view: ["roster.manage"],
  exportCaps: ["roster.manage"],
  // The date range is applied here too, so only the chosen days are read.
  base: (ctx) => Prisma.sql`
    SELECT s.id, s.date, to_char(s.date, 'YYYY-MM-DD') AS day, s.start_at, s.end_at, s.area::text AS area, s.status::text AS status,
      s.employee_id, s.previous_employee_id, u.name, u.role::text AS role, pu.name AS previous_name,
      floor(extract(epoch FROM s.end_at - s.start_at) / 60)::int AS minutes,
      lv.type AS leave_type
    FROM shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN employees pe ON pe.id = s.previous_employee_id
    LEFT JOIN users pu ON pu.id = pe.user_id
    LEFT JOIN LATERAL (SELECT l.type::text AS type FROM leave_requests l
                        WHERE l.employee_id = COALESCE(s.employee_id, s.previous_employee_id) AND l.status = 'APPROVED'
                          AND l.start_date <= s.date AND l.end_date >= s.date LIMIT 1) lv ON TRUE
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND s.date >= ${ctx.from}::date` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND s.date <= ${ctx.to}::date` : Prisma.empty}`,
  search: ["b.name", "b.previous_name"],
  dateColumn: { expr: "b.date", label: "Shift date", kind: "date" },
  facets: [
    { key: "when", label: "When", expr: `CASE WHEN b.date >= ${TODAY} THEN 'upcoming' ELSE 'past' END`, options: [{ value: "upcoming", label: "Today and later" }, { value: "past", label: "Before today" }] },
    { key: "area", label: "Area", expr: "b.area", options: [
      { value: "FRONT_DESK", label: "Front desk" }, { value: "BAR", label: "Bar" }, { value: "KITCHEN", label: "Kitchen" }, { value: "SHOP", label: "Shop" }, { value: "COURTS", label: "Courts" },
    ] },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "ASSIGNED", label: "Assigned" }, { value: "OPEN", label: "Open (needs cover)" }] },
    {
      key: "employee", label: "Employee", expr: "COALESCE(b.employee_id, 'open')",
      labelsSql: "SELECT e.id AS value, u.name AS label FROM employees e JOIN users u ON u.id = e.user_id UNION ALL SELECT 'open', 'Nobody (open shift)'",
    },
  ],
  sorts: {
    time: { label: "Soonest first", sql: "b.start_at ASC, b.name ASC NULLS FIRST" },
    latest: { label: "Latest first", sql: "b.start_at DESC, b.name ASC NULLS FIRST" },
    name: { label: "Employee", sql: "b.name ASC NULLS FIRST, b.start_at ASC" },
  },
  defaultSort: "time",
  defaults: () => ({ when: "upcoming" }),
  summary: [
    { key: "open", label: "Open shifts", sql: "count(*) FILTER (WHERE b.status = 'OPEN')", format: "count", apply: { status: "OPEN" } },
    { key: "today", label: "Shifts today", sql: `count(*) FILTER (WHERE b.status = 'ASSIGNED' AND b.date = ${TODAY})`, format: "count", apply: { range: "TODAY", status: "ASSIGNED" } },
    { key: "hours", label: "Hours assigned", sql: "COALESCE(sum(b.minutes) FILTER (WHERE b.status = 'ASSIGNED'), 0)", format: "minutes", apply: { status: "ASSIGNED" } },
  ],
  csv: [
    { key: "day", label: "Date" }, { key: "start_at", label: "Start", format: "datetime" }, { key: "end_at", label: "End", format: "datetime" },
    { key: "area", label: "Area" }, { key: "status", label: "Status" }, { key: "name", label: "Employee" }, { key: "role", label: "Role" },
    { key: "previous_name", label: "Was assigned to" }, { key: "minutes", label: "Minutes" }, { key: "leave_type", label: "On leave" },
  ],
};
