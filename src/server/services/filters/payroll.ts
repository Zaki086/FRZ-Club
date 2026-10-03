// v3 §3.2: monthly payroll runs (Owner, Accountant) — draft → approved by the owner → paid — with their totals.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const payrollList: ListDef = {
  name: "payroll",
  title: "Payroll runs",
  view: ["payroll"],
  exportCaps: ["payroll"],
  base: () => Prisma.sql`
    SELECT r.id, r.month, split_part(r.month, '-', 1) AS year, to_date(r.month || '-01', 'YYYY-MM-DD') AS month_start,
      r.status::text AS status, r.method::text AS method, r.created_at, r.approved_at, r.paid_at, au.name AS approved_by_name,
      COALESCE(p.employees, 0)::int AS employees, COALESCE(p.gross, 0)::bigint AS gross, COALESCE(p.deductions, 0)::bigint AS deductions,
      COALESCE(p.net, 0)::bigint AS net, COALESCE(p.unpaid_days, 0)::int AS unpaid_days
    FROM payroll_runs r
    LEFT JOIN users au ON au.id = r.approved_by
    LEFT JOIN LATERAL (
      SELECT count(*) AS employees, sum(s.gross) AS gross, sum(s.deductions) AS deductions, sum(s.net) AS net, sum(s.unpaid_days) AS unpaid_days
      FROM payslips s WHERE s.run_id = r.id
    ) p ON TRUE`,
  search: ["b.month", "b.approved_by_name"],
  dateColumn: { expr: "b.month_start", label: "Month", kind: "date" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "DRAFT", label: "Draft (needs the owner)" }, { value: "APPROVED", label: "Approved (ready to pay)" }, { value: "PAID", label: "Paid" },
    ] },
    { key: "year", label: "Year", expr: "b.year" },
    { key: "month", label: "Month", expr: "b.month" },
  ],
  sorts: {
    month: { label: "Latest month first", sql: "b.month DESC" },
    oldest: { label: "Oldest month first", sql: "b.month ASC" },
    net: { label: "Largest net pay", sql: "b.net DESC, b.month DESC" },
  },
  defaultSort: "month",
  summary: [
    { key: "draft", label: "Awaiting owner approval", sql: "count(*) FILTER (WHERE b.status = 'DRAFT')", format: "count", apply: { status: "DRAFT" } },
    { key: "approved", label: "Approved, to pay", sql: "COALESCE(sum(b.net) FILTER (WHERE b.status = 'APPROVED'), 0)", format: "money", apply: { status: "APPROVED" } },
    { key: "paid", label: "Paid out", sql: "COALESCE(sum(b.net) FILTER (WHERE b.status = 'PAID'), 0)", format: "money", apply: { status: "PAID" } },
    { key: "net", label: "Net pay (these runs)", sql: "COALESCE(sum(b.net), 0)", format: "money", apply: {} },
  ],
  csv: [
    { key: "month", label: "Month" }, { key: "status", label: "Status" }, { key: "employees", label: "Employees" },
    { key: "gross", label: "Gross (₹)", format: "money" }, { key: "deductions", label: "Deductions (₹)", format: "money" }, { key: "net", label: "Net (₹)", format: "money" },
    { key: "approved_by_name", label: "Approved by" }, { key: "approved_at", label: "Approved", format: "datetime" },
    { key: "paid_at", label: "Paid", format: "datetime" }, { key: "method", label: "Paid by" },
  ],
};
