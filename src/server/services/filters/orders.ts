// v3 §3.2: online shop orders (website and member portal) — the board and the list are two views of these rows.
// Each row carries its lines, timeline and the next steps staff may take (the same rule as setOrderStatus).
import { Prisma } from "@prisma/client";
import { ORDER_NEXT } from "../shop";
import type { ListDef } from "./core";

export const OPEN_ORDER_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP", "PACKED", "OUT_FOR_DELIVERY"];
const NOT_CANCELLED = ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP", "PACKED", "OUT_FOR_DELIVERY", "COLLECTED", "DELIVERED"];

/** ORDER_NEXT as SQL: text[] of the statuses an order can move to next. */
const nextSql = () => {
  const whens = (Object.entries(ORDER_NEXT) as Array<[string, Record<string, string[]>]>).flatMap(([f, m]) =>
    Object.entries(m).map(([from, to]) => `WHEN o.fulfilment::text = '${f}' AND o.status::text = '${from}' THEN ARRAY[${to.map((t) => `'${t}'`).join(", ")}]::text[]`),
  );
  return `CASE ${whens.join(" ")} ELSE ARRAY[]::text[] END`;
};

const IST_TODAY = "(app_now() AT TIME ZONE 'Asia/Kolkata')::date";

export const ordersList: ListDef = {
  name: "orders",
  title: "Online orders",
  view: ["shop.fulfil"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT o.id, o.code, o.status::text AS status, o.fulfilment::text AS fulfilment, o.payment_option::text AS payment_option,
      o.address, o.hold_expires_at, o.created_at, o.cancel_reason, o.track_token, o.bill_id, o.member_id,
      COALESCE(m.name, g.name, bl.customer_name) AS customer, COALESCE(m.phone, g.phone) AS phone,
      CASE WHEN o.member_id IS NOT NULL THEN 'member' ELSE 'guest' END AS customer_kind,
      bl.total, bl.amount_paid, bl.amount_refunded, bl.status::text AS bill_status,
      CASE WHEN bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END AS due,
      ${Prisma.raw(nextSql())} AS next_statuses,
      COALESCE((SELECT json_agg(json_build_object('id', l.id, 'variantId', l.variant_id,
                  'name', COALESCE(p.name || CASE WHEN v.label <> 'Standard' THEN ' — ' || v.label ELSE '' END, '?'),
                  'qty', l.qty, 'unitPrice', l.unit_price, 'netAmount', l.net_amount) ORDER BY l.created_at, l.id)
                  FROM shop_order_lines l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
                 WHERE l.order_id = o.id), '[]'::json) AS lines,
      COALESCE((SELECT json_agg(json_build_object('status', e.status::text, 'at', e.at, 'note', e.note) ORDER BY e.at)
                  FROM shop_order_events e WHERE e.order_id = o.id), '[]'::json) AS events,
      (SELECT string_agg(p.name, ' ') FROM shop_order_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.order_id = o.id) AS items_text
    FROM shop_orders o
    JOIN bills bl ON bl.id = o.bill_id
    LEFT JOIN members m ON m.id = o.member_id
    LEFT JOIN guests g ON g.id = o.guest_id`,
  search: ["b.code", "b.customer", "b.phone", "b.items_text"],
  dateColumn: { expr: "b.created_at", label: "Ordered", kind: "timestamp" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "PENDING_PAYMENT", label: "Awaiting payment" }, { value: "CONFIRMED", label: "Confirmed" }, { value: "READY_FOR_PICKUP", label: "Ready for pickup" },
      { value: "PACKED", label: "Packed" }, { value: "OUT_FOR_DELIVERY", label: "Out for delivery" }, { value: "COLLECTED", label: "Collected" },
      { value: "DELIVERED", label: "Delivered" }, { value: "CANCELLED", label: "Cancelled" },
    ] },
    { key: "fulfilment", label: "Fulfilment", expr: "b.fulfilment", options: [{ value: "PICKUP", label: "Pickup" }, { value: "DELIVERY", label: "Delivery" }] },
    { key: "payment", label: "Payment", expr: "CASE WHEN b.amount_refunded > 0 THEN 'refunded' WHEN b.due > 0 THEN 'due' WHEN b.amount_paid > 0 THEN 'paid' ELSE 'none' END", options: [
      { value: "paid", label: "Paid" }, { value: "due", label: "Payment due" }, { value: "refunded", label: "Refunded" }, { value: "none", label: "Nothing paid" },
    ] },
    { key: "option", label: "Pays by", expr: "b.payment_option", options: [
      { value: "ONLINE", label: "Paid online" }, { value: "PAY_AT_PICKUP", label: "Pay at pickup" }, { value: "PAY_ON_DELIVERY", label: "Pay on delivery" },
    ] },
    { key: "customer", label: "Customer", expr: "b.customer_kind", options: [{ value: "member", label: "Member" }, { value: "guest", label: "Guest" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    oldest: { label: "Oldest first", sql: "b.created_at ASC" },
    total: { label: "Largest first", sql: "b.total DESC, b.created_at DESC" },
  },
  defaultSort: "newest",
  defaults: () => ({ status: OPEN_ORDER_STATUSES.join(",") }),
  summary: [
    { key: "prepare", label: "To prepare", sql: "count(*) FILTER (WHERE b.status = 'CONFIRMED')", format: "count", apply: { status: "CONFIRMED" } },
    { key: "ready", label: "Ready for pickup", sql: "count(*) FILTER (WHERE b.status = 'READY_FOR_PICKUP')", format: "count", apply: { status: "READY_FOR_PICKUP" } },
    { key: "out", label: "Out for delivery", sql: "count(*) FILTER (WHERE b.status = 'OUT_FOR_DELIVERY')", format: "count", apply: { status: "OUT_FOR_DELIVERY" } },
    // Today's takings are every order placed today that was not cancelled, whatever the other filters say.
    { key: "today", label: "Online sales today", sql: `(SELECT COALESCE(sum(x.total), 0) FROM list_base_orders x WHERE x.status <> 'CANCELLED' AND (x.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY})`, format: "money", apply: { status: NOT_CANCELLED.join(","), range: "TODAY" } },
  ],
  csv: [
    { key: "code", label: "Order" }, { key: "created_at", label: "Ordered", format: "datetime" }, { key: "customer", label: "Customer" }, { key: "phone", label: "Mobile" },
    { key: "customer_kind", label: "Member / guest" }, { key: "status", label: "Status" }, { key: "fulfilment", label: "Fulfilment" }, { key: "payment_option", label: "Pays by" },
    { key: "total", label: "Total (₹)", format: "money" }, { key: "due", label: "Due (₹)", format: "money" }, { key: "items_text", label: "Items" }, { key: "address", label: "Address" },
  ],
};
