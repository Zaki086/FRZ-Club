// v3 §3.2: leave requests (ST-4/ST-5, LV-1…LV-3) — pending first with the approve/reject action on the row.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const TODAY = "(app_now() AT TIME ZONE 'Asia/Kolkata')::date";
const THIS_MONTH = `date_trunc('month', ${TODAY})`;

// The strip shows club-wide figures (they ignore the list's filters), because the list opens on PENDING only and
// "approved" / "expired" would otherwise always read 0. `+ 0 * count(*)` keeps one summary row even when nothing matches.
const club = (where: string, what = "count(*)") => `(SELECT COALESCE(${what}, 0) FROM list_base_leave x WHERE ${where}) + 0 * count(*)`;

export const leaveList: ListDef = {
  name: "leave",
  title: "Leave requests",
  view: ["leave.approve"],
  exportCaps: ["leave.approve"],
  base: () => Prisma.sql`
    SELECT l.id, l.employee_id, u.name, u.role::text AS role, l.type::text AS type, l.status::text AS status,
      l.start_date, l.end_date, to_char(l.start_date, 'YYYY-MM-DD') AS start_day, to_char(l.end_date, 'YYYY-MM-DD') AS end_day,
      l.days, l.reason, l.decided_by, du.name AS decided_by_name, l.decided_at, l.decision_note, l.created_at,
      (SELECT count(*) FROM shifts s WHERE s.employee_id = l.employee_id AND s.status = 'ASSIGNED' AND s.date >= l.start_date AND s.date <= l.end_date)::int AS shifts_affected
    FROM leave_requests l
    JOIN employees e ON e.id = l.employee_id
    JOIN users u ON u.id = e.user_id
    LEFT JOIN users du ON du.id = l.decided_by`,
  search: ["b.name", "b.reason", "b.decision_note"],
  dateColumn: { expr: "b.start_date", label: "Starts", kind: "date" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "PENDING", label: "Pending" }, { value: "APPROVED", label: "Approved" }, { value: "REJECTED", label: "Rejected" }, { value: "EXPIRED", label: "Expired" },
    ] },
    { key: "type", label: "Type", expr: "b.type", options: [{ value: "CASUAL", label: "Casual" }, { value: "SICK", label: "Sick" }, { value: "UNPAID", label: "Unpaid" }] },
    { key: "employee", label: "Employee", expr: "b.employee_id", labelsSql: "SELECT e.id AS value, u.name AS label FROM employees e JOIN users u ON u.id = e.user_id" },
    {
      key: "month", label: "Month",
      expr: `CASE WHEN date_trunc('month', b.start_date) = ${THIS_MONTH} THEN 'this' WHEN b.start_date > ${TODAY} THEN 'later' ELSE 'earlier' END`,
      options: [{ value: "this", label: "Starts this month" }, { value: "later", label: "Starts in a later month" }, { value: "earlier", label: "Started before this month" }],
    },
  ],
  sorts: {
    todo: { label: "To decide first", sql: "CASE b.status WHEN 'PENDING' THEN 0 ELSE 1 END, b.start_date ASC, b.name" },
    start: { label: "Start date", sql: "b.start_date ASC, b.name" },
    newest: { label: "Newest request", sql: "b.created_at DESC" },
  },
  defaultSort: "todo",
  defaults: () => ({ status: "PENDING" }),
  summary: [
    { key: "pending", label: "Pending", sql: club("x.status = 'PENDING'"), format: "count", apply: { status: "PENDING" } },
    {
      key: "approved", label: "Days approved this month",
      sql: club(`x.status = 'APPROVED' AND date_trunc('month', x.start_date) = ${THIS_MONTH}`, "sum(x.days)"),
      format: "count", apply: { status: "APPROVED", month: "this" },
    },
    { key: "expired", label: "Expired", sql: club("x.status = 'EXPIRED'"), format: "count", apply: { status: "EXPIRED" } },
  ],
  csv: [
    { key: "name", label: "Employee" }, { key: "role", label: "Role" }, { key: "type", label: "Type" }, { key: "start_day", label: "From" }, { key: "end_day", label: "To" },
    { key: "days", label: "Days" }, { key: "reason", label: "Reason" }, { key: "status", label: "Status" }, { key: "created_at", label: "Requested", format: "datetime" },
    { key: "decided_by_name", label: "Decided by" }, { key: "decided_at", label: "Decided", format: "datetime" }, { key: "decision_note", label: "Note" },
  ],
};
