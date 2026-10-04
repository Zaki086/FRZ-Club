// v3 §3.2: counter sales — who bought, what, how they paid and who sold it. Opens on today's sales.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const salesList: ListDef = {
  name: "sales",
  title: "Counter sales",
  view: ["shop.view"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT s.id, s.code, s.created_at, s.bill_id, s.member_id, s.sold_by, u.name AS sold_by_name,
      COALESCE(m.name, g.name, bl.customer_name) AS customer,
      -- v6 WI-6: "Walk-in" = every sale not to a member (WALK_IN tier): with a phone (guest) or anonymous (WALK_IN).
      CASE WHEN bl.customer_kind = 'MEMBER' THEN 'member' ELSE 'walkin' END AS customer_kind, bl.customer_kind AS bill_customer_kind,
      bl.total, bl.discount_total AS discount, bl.amount_refunded AS refunded, bl.status::text AS status,
      COALESCE((SELECT array_agg(DISTINCT p.method::text) FROM payments p WHERE p.bill_id = s.bill_id AND p.type = 'PAYMENT' AND p.status = 'SUCCEEDED'), ARRAY[]::text[]) AS methods,
      COALESCE((SELECT json_agg(json_build_object('id', l.id, 'description', l.description, 'qty', l.qty, 'netAmount', l.net_amount, 'variantId', l.variant_id) ORDER BY l.created_at, l.id)
                  FROM bill_lines l WHERE l.bill_id = s.bill_id AND l.voided_at IS NULL), '[]'::json) AS lines,
      (SELECT string_agg(l.description, ' ') FROM bill_lines l WHERE l.bill_id = s.bill_id AND l.voided_at IS NULL) AS items_text,
      (SELECT COALESCE(sum(l.qty), 0) FROM bill_lines l WHERE l.bill_id = s.bill_id AND l.voided_at IS NULL)::int AS units
    FROM counter_sales s
    JOIN bills bl ON bl.id = s.bill_id
    LEFT JOIN users u ON u.id = s.sold_by
    LEFT JOIN members m ON m.id = s.member_id
    LEFT JOIN guests g ON g.id = s.guest_id`,
  search: ["b.code", "b.customer", "b.items_text"],
  dateColumn: { expr: "b.created_at", label: "Sold", kind: "timestamp" },
  facets: [
    { key: "method", label: "Paid by", expr: "b.methods", multi: true, options: [
      { value: "CASH", label: "Cash" }, { value: "UPI", label: "UPI" }, { value: "CARD", label: "Card" }, { value: "ONLINE", label: "Online" }, { value: "BANK_TRANSFER", label: "Bank transfer" },
    ] },
    { key: "customer", label: "Customer", expr: "b.customer_kind", options: [{ value: "member", label: "Member" }, { value: "walkin", label: "Walk-in" }] },
    { key: "staff", label: "Sold by", expr: "b.sold_by", meAlias: true, labelsSql: "SELECT id AS value, name AS label FROM users" },
    { key: "status", label: "Bill", expr: "b.status", options: [
      { value: "PAID", label: "Paid" }, { value: "PARTIAL", label: "Part paid" }, { value: "UNPAID", label: "Unpaid" },
      { value: "PARTIALLY_REFUNDED", label: "Part returned" }, { value: "REFUNDED", label: "Returned" }, { value: "VOID", label: "Void" },
    ] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    oldest: { label: "Oldest first", sql: "b.created_at ASC" },
    total: { label: "Largest first", sql: "b.total DESC, b.created_at DESC" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "TODAY" }),
  summary: [
    { key: "count", label: "Sales", sql: "count(*) FILTER (WHERE b.status <> 'VOID')", format: "count", apply: {} },
    { key: "total", label: "Total sales", sql: "COALESCE(sum(b.total) FILTER (WHERE b.status <> 'VOID'), 0)", format: "money", apply: {} },
    { key: "discount", label: "Discounts given", sql: "COALESCE(sum(b.discount) FILTER (WHERE b.status <> 'VOID'), 0)", format: "money", apply: {} },
    { key: "returned", label: "Returned", sql: "COALESCE(sum(b.refunded), 0)", format: "money", apply: { status: "PARTIALLY_REFUNDED,REFUNDED" } },
  ],
  csv: [
    { key: "code", label: "Sale" }, { key: "created_at", label: "Sold", format: "datetime" }, { key: "customer", label: "Customer" }, { key: "customer_kind", label: "Member / walk-in" },
    { key: "items_text", label: "Items" }, { key: "units", label: "Units" }, { key: "methods", label: "Paid by" }, { key: "total", label: "Total (₹)", format: "money" },
    { key: "discount", label: "Discount (₹)", format: "money" }, { key: "refunded", label: "Returned (₹)", format: "money" }, { key: "status", label: "Bill" }, { key: "sold_by_name", label: "Sold by" },
  ],
};
