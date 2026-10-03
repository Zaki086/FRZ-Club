// v3 §3.2: expense bills and payables. OVERDUE is derived (unpaid and past the due date) and offered beside the
// stored states, so the overdue-expenses notification link `?status=OVERDUE` (and the dashboard's `?status=UNPAID`)
// keep working.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const EXPENSE_CATEGORY_OPTIONS = [
  { value: "STOCK_PURCHASE", label: "Stock purchase" }, { value: "UTILITIES", label: "Utilities" }, { value: "RENT", label: "Rent" },
  { value: "MAINTENANCE", label: "Maintenance" }, { value: "MARKETING", label: "Marketing" }, { value: "OTHER", label: "Other" },
];

export const expensesList: ListDef = {
  name: "expenses",
  title: "Expenses & payables",
  view: ["expenses.view"],
  exportCaps: ["finance.reports"],
  base: () => Prisma.sql`
    SELECT e.id, e.vendor, e.category::text AS category, e.description, e.amount, e.input_gst,
      e.bill_date, e.due_date, to_char(e.bill_date, 'YYYY-MM-DD') AS bill_day, to_char(e.due_date, 'YYYY-MM-DD') AS due_day,
      e.status::text AS status, e.paid_at, e.method::text AS method, e.attachment_url, e.created_at,
      (e.status = 'UNPAID' AND e.due_date < (app_now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue
    FROM expense_bills e`,
  search: ["b.vendor", "b.description"],
  dateColumn: { expr: "b.bill_date", label: "Bill date", kind: "date" },
  facets: [
    // An overdue bill is still UNPAID, so it matches both (as the old status filter did).
    { key: "status", label: "Status", expr: "CASE WHEN b.overdue THEN ARRAY[b.status, 'OVERDUE'] ELSE ARRAY[b.status] END", multi: true, options: [
      { value: "UNPAID", label: "Unpaid" }, { value: "OVERDUE", label: "Overdue" }, { value: "PAID", label: "Paid" }, { value: "CANCELLED", label: "Cancelled" },
    ] },
    { key: "category", label: "Category", expr: "b.category", options: EXPENSE_CATEGORY_OPTIONS },
    { key: "vendor", label: "Vendor", expr: "b.vendor" },
    { key: "bill", label: "Bill attached", expr: "CASE WHEN b.attachment_url IS NOT NULL THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Bill attached" }, { value: "no", label: "No bill attached" }] },
  ],
  sorts: {
    newest: { label: "Newest bill first", sql: "b.bill_date DESC, b.created_at DESC" },
    due: { label: "Due soonest", sql: "b.due_date ASC, b.created_at DESC" },
    amount: { label: "Largest first", sql: "b.amount DESC, b.bill_date DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "unpaid", label: "Unpaid", sql: "COALESCE(sum(b.amount) FILTER (WHERE b.status = 'UNPAID'), 0)", format: "money", apply: { status: "UNPAID" } },
    { key: "overdue", label: "Overdue", sql: "COALESCE(sum(b.amount) FILTER (WHERE b.overdue), 0)", format: "money", apply: { status: "OVERDUE" } },
    { key: "overdueBills", label: "Overdue bills", sql: "count(*) FILTER (WHERE b.overdue)", format: "count", apply: { status: "OVERDUE" } },
    { key: "noBill", label: "No bill attached", sql: "count(*) FILTER (WHERE b.attachment_url IS NULL AND b.status <> 'CANCELLED')", format: "count", apply: { bill: "no", status: "UNPAID,PAID" } },
  ],
  csv: [
    { key: "vendor", label: "Vendor" }, { key: "category", label: "Category" }, { key: "description", label: "Description" },
    { key: "bill_day", label: "Bill date" }, { key: "due_day", label: "Due" }, { key: "amount", label: "Amount (₹)", format: "money" },
    { key: "input_gst", label: "Input GST (₹)", format: "money" }, { key: "status", label: "Status" }, { key: "overdue", label: "Overdue" },
    { key: "method", label: "Paid by" }, { key: "paid_at", label: "Paid", format: "datetime" },
  ],
};
