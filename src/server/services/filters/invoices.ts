// v3 §3.2: every invoice (membership, business and member) with the standard FilterBar. OVERDUE is derived
// (issued or part-paid and past the due date), never stored — the status facet offers it beside the stored states,
// so `?status=OVERDUE` (and the other old `?status=` / `?clientId=` links) keep working.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const invoicesList: ListDef = {
  name: "invoices",
  title: "Invoices",
  view: ["invoices"],
  exportCaps: ["finance.reports"],
  base: () => Prisma.sql`
    SELECT i.id, i.number, i.kind, i.status::text AS status, i.business_client_id AS client_id, i.member_id, i.bill_id, i.notes,
      COALESCE(c.name, bl.customer_name) AS customer,
      i.issue_date, i.due_date, to_char(i.issue_date, 'YYYY-MM-DD') AS issue_day, to_char(i.due_date, 'YYYY-MM-DD') AS due_day,
      COALESCE(i.issue_date, (i.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS doc_date, i.created_at,
      bl.total, bl.amount_paid - bl.amount_refunded AS paid,
      CASE WHEN bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END AS due,
      (i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.due_date IS NOT NULL AND i.due_date < (app_now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue
    FROM invoices i
    JOIN bills bl ON bl.id = i.bill_id
    LEFT JOIN business_clients c ON c.id = i.business_client_id`,
  search: ["b.number", "b.customer", "b.notes"],
  dateColumn: { expr: "b.doc_date", label: "Invoice date", kind: "date" },
  facets: [
    // An overdue invoice is still ISSUED / PARTIALLY_PAID, so it matches both (as the old status filter did).
    { key: "status", label: "Status", expr: "CASE WHEN b.overdue THEN ARRAY[b.status, 'OVERDUE'] ELSE ARRAY[b.status] END", multi: true, options: [
      { value: "DRAFT", label: "Draft" }, { value: "ISSUED", label: "Issued" }, { value: "PARTIALLY_PAID", label: "Partially paid" },
      { value: "PAID", label: "Paid" }, { value: "OVERDUE", label: "Overdue" }, { value: "CANCELLED", label: "Cancelled" },
    ] },
    { key: "clientId", label: "Client", expr: "b.client_id", labelsSql: "SELECT id AS value, name AS label FROM business_clients" },
    { key: "kind", label: "Type", expr: "b.kind", options: [
      { value: "MEMBERSHIP", label: "Membership" }, { value: "BUSINESS", label: "Business" }, { value: "MEMBER", label: "Member" },
    ] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    due: { label: "Due soonest", sql: "b.due_date ASC NULLS LAST, b.created_at DESC" },
    balance: { label: "Largest balance", sql: "b.due DESC, b.created_at DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "issued", label: "Issued", sql: "COALESCE(sum(b.total) FILTER (WHERE b.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')), 0)", format: "money", apply: { status: "ISSUED,PARTIALLY_PAID,PAID" } },
    { key: "outstanding", label: "Outstanding", sql: "COALESCE(sum(b.due) FILTER (WHERE b.status IN ('ISSUED', 'PARTIALLY_PAID')), 0)", format: "money", apply: { status: "ISSUED,PARTIALLY_PAID" } },
    { key: "overdue", label: "Overdue", sql: "count(*) FILTER (WHERE b.overdue)", format: "count", apply: { status: "OVERDUE" } },
    { key: "drafts", label: "Drafts to issue", sql: "count(*) FILTER (WHERE b.status = 'DRAFT')", format: "count", apply: { status: "DRAFT" } },
  ],
  csv: [
    { key: "number", label: "Number" }, { key: "kind", label: "Type" }, { key: "customer", label: "Customer" },
    { key: "issue_day", label: "Issued" }, { key: "due_day", label: "Due" }, { key: "total", label: "Total (₹)", format: "money" },
    { key: "paid", label: "Paid (₹)", format: "money" }, { key: "due", label: "Balance (₹)", format: "money" }, { key: "status", label: "Status" },
    { key: "overdue", label: "Overdue" },
  ],
};
