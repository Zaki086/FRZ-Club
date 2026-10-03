// v3 §3.2: business clients with what they still owe. Outstanding is the same rule as before: every open bill of
// the client (not closed) minus what was paid net of refunds, never below zero.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const clientsList: ListDef = {
  name: "clients",
  title: "Business clients",
  view: ["invoices"],
  exportCaps: ["finance.reports"],
  base: () => Prisma.sql`
    SELECT c.id, c.name, c.gstin, c.state_code, c.address, c.contact_name, c.contact_email, c.contact_phone, c.payment_terms_days,
      c.created_at, c.archived_at, (c.archived_at IS NULL) AS active,
      COALESCE(o.outstanding, 0)::bigint AS outstanding,
      COALESCE(inv.invoices, 0)::int AS invoices, COALESCE(inv.overdue, 0)::int AS overdue
    FROM business_clients c
    LEFT JOIN LATERAL (
      SELECT sum(GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded))) AS outstanding
      FROM bills bl WHERE bl.business_client_id = c.id AND bl.closed_at IS NULL
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS invoices,
        count(*) FILTER (WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.due_date < (app_now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue
      FROM invoices i WHERE i.business_client_id = c.id
    ) inv ON TRUE`,
  search: ["b.name", "b.gstin", "b.contact_name", "b.contact_email", "b.contact_phone"],
  facets: [
    { key: "outstanding", label: "Outstanding", expr: "CASE WHEN b.outstanding > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has outstanding" }, { value: "no", label: "Nothing due" }] },
    { key: "overdue", label: "Overdue", expr: "CASE WHEN b.overdue > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has overdue invoices" }, { value: "no", label: "Nothing overdue" }] },
    { key: "active", label: "Active", expr: "CASE WHEN b.active THEN 'active' ELSE 'archived' END", options: [{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }] },
  ],
  sorts: {
    name: { label: "Name A–Z", sql: "b.name ASC" },
    outstanding: { label: "Most outstanding", sql: "b.outstanding DESC, b.name ASC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
  },
  defaultSort: "name",
  summary: [
    { key: "clients", label: "Clients", sql: "count(*)", format: "count", apply: {} },
    { key: "owing", label: "Clients with outstanding", sql: "count(*) FILTER (WHERE b.outstanding > 0)", format: "count", apply: { outstanding: "yes" } },
    { key: "outstanding", label: "Outstanding", sql: "COALESCE(sum(b.outstanding), 0)", format: "money", apply: { outstanding: "yes" } },
    { key: "overdue", label: "Clients with overdue invoices", sql: "count(*) FILTER (WHERE b.overdue > 0)", format: "count", apply: { overdue: "yes" } },
  ],
  csv: [
    { key: "name", label: "Client" }, { key: "gstin", label: "GSTIN" }, { key: "state_code", label: "State code" }, { key: "address", label: "Address" },
    { key: "contact_name", label: "Contact" }, { key: "contact_email", label: "Email" }, { key: "contact_phone", label: "Phone" },
    { key: "payment_terms_days", label: "Terms (days)" }, { key: "invoices", label: "Invoices" }, { key: "outstanding", label: "Outstanding (₹)", format: "money" },
  ],
  // As before: archived clients are hidden until asked for.
  defaults: () => ({ active: "active" }),
};
