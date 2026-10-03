// v3 §3.2: the single append-only ledger (Owner, Accountant). Refunds are negative IN entries under their original
// source; expenses and payroll are OUT entries (negative amounts). Money in = Σ IN (net of refunds), money out = −Σ OUT.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const LEDGER_SOURCE_OPTIONS = [
  { value: "COURTS", label: "Courts" }, { value: "SOCIAL", label: "Social play" }, { value: "SHOP", label: "Shop" }, { value: "BAR", label: "Bar & cafe" },
  { value: "MEMBERSHIP", label: "Membership" }, { value: "INVOICE", label: "Invoices" }, { value: "EXPENSE", label: "Expenses" }, { value: "PAYROLL", label: "Payroll" },
];
const LEDGER_METHOD_OPTIONS = [
  { value: "CASH", label: "Cash" }, { value: "UPI", label: "UPI" }, { value: "CARD", label: "Card" }, { value: "ONLINE", label: "Online" }, { value: "BANK_TRANSFER", label: "Bank transfer" },
];

export const ledgerList: ListDef = {
  name: "ledger",
  title: "Ledger",
  view: ["finance.reports"],
  exportCaps: ["finance.reports"],
  base: () => Prisma.sql`
    SELECT l.id, l.occurred_at, l.source::text AS source, l.direction::text AS direction, l.method::text AS method, l.description,
      l.amount, l.tax_amount, l.bill_id, l.payment_id, l.ref_type, l.ref_id, bl.customer_name AS customer
    FROM ledger_entries l
    LEFT JOIN bills bl ON bl.id = l.bill_id`,
  search: ["b.description"],
  dateColumn: { expr: "b.occurred_at", label: "When", kind: "timestamp" },
  facets: [
    { key: "source", label: "Source", expr: "b.source", options: LEDGER_SOURCE_OPTIONS },
    { key: "method", label: "Method", expr: "b.method", options: LEDGER_METHOD_OPTIONS },
    { key: "direction", label: "Direction", expr: "b.direction", options: [{ value: "IN", label: "Money in" }, { value: "OUT", label: "Money out" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.occurred_at DESC, b.id DESC" },
    oldest: { label: "Oldest first", sql: "b.occurred_at ASC, b.id ASC" },
    amount: { label: "Largest amount", sql: "abs(b.amount) DESC, b.occurred_at DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "in", label: "Money in (after refunds)", sql: "COALESCE(sum(b.amount) FILTER (WHERE b.direction = 'IN'), 0)", format: "money", apply: { direction: "IN" } },
    { key: "out", label: "Money out", sql: "COALESCE(sum(-b.amount) FILTER (WHERE b.direction = 'OUT'), 0)", format: "money", apply: { direction: "OUT" } },
    { key: "net", label: "Net", sql: "COALESCE(sum(b.amount), 0)", format: "money", apply: {} },
    { key: "refunds", label: "Refunds", sql: "COALESCE(sum(-b.amount) FILTER (WHERE b.direction = 'IN' AND b.amount < 0), 0)", format: "money", apply: {} },
  ],
  csv: [
    { key: "occurred_at", label: "When (IST)", format: "datetime" }, { key: "source", label: "Source" }, { key: "direction", label: "Direction" },
    { key: "method", label: "Method" }, { key: "description", label: "Description" }, { key: "amount", label: "Amount (₹)", format: "money" },
    { key: "tax_amount", label: "Tax (₹)", format: "money" },
  ],
  // As before: the ledger opens on today.
  defaults: () => ({ range: "TODAY" }),
};
