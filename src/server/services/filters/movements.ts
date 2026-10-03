// v3 §3.2: every stock movement (SH-3) — receipts, sales, reservations, hand-overs, adjustments and returns —
// with the product, who did it and what it belongs to.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const CATEGORY = [
  { value: "RACKETS", label: "Rackets" }, { value: "BALLS", label: "Balls" }, { value: "SHOES", label: "Shoes" },
  { value: "ACCESSORIES", label: "Accessories" }, { value: "APPAREL", label: "Apparel" }, { value: "SERVICES", label: "Services" },
];

export const MOVEMENT_TYPES = [
  { value: "RECEIPT", label: "Received" }, { value: "COUNTER_SALE", label: "Counter sale" }, { value: "RESERVE", label: "Reserved (online)" },
  { value: "RELEASE", label: "Released (online)" }, { value: "ONLINE_FULFIL", label: "Handed over (online)" }, { value: "ADJUSTMENT", label: "Adjustment" },
  { value: "RETURN", label: "Returned" },
];

export const movementsList: ListDef = {
  name: "movements",
  title: "Stock movements",
  view: ["shop.view"],
  exportCaps: ["shop.stock", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT m.id, m.created_at, m.reason::text AS reason, m.qty_on_hand_delta AS on_hand_delta, m.qty_reserved_delta AS reserved_delta,
      m.ref_type, m.ref_id, m.unit_cost, m.note, m.actor_id, u.name AS actor_name,
      m.variant_id, v.sku, v.label, p.id AS product_id, p.name AS product, p.category::text AS category,
      CASE m.ref_type
        WHEN 'counter_sale' THEN (SELECT cs.code FROM counter_sales cs WHERE cs.id = m.ref_id)
        WHEN 'shop_order' THEN (SELECT so.code FROM shop_orders so WHERE so.id = m.ref_id)
        WHEN 'return' THEN COALESCE((SELECT cs.code FROM counter_sales cs WHERE cs.bill_id = m.ref_id), (SELECT so.code FROM shop_orders so WHERE so.bill_id = m.ref_id))
        ELSE NULL END AS ref_code
    FROM stock_movements m
    JOIN product_variants v ON v.id = m.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN users u ON u.id = m.actor_id`,
  search: ["b.product", "b.sku", "b.note", "b.ref_code"],
  dateColumn: { expr: "b.created_at", label: "When", kind: "timestamp" },
  facets: [
    { key: "type", label: "Movement", expr: "b.reason", options: MOVEMENT_TYPES },
    { key: "category", label: "Category", expr: "b.category", options: CATEGORY },
    { key: "product", label: "Product", expr: "b.product_id", labelsSql: "SELECT id AS value, name AS label FROM products" },
    { key: "staff", label: "By", expr: "COALESCE(b.actor_id, 'system')", meAlias: true, labelsSql: "SELECT id AS value, name AS label FROM users UNION ALL SELECT 'system', 'System / online'" },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.created_at DESC, b.id" },
    oldest: { label: "Oldest first", sql: "b.created_at ASC, b.id" },
    product: { label: "Product", sql: "b.product ASC, b.label ASC, b.created_at DESC" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "LAST_7" }),
  summary: [
    { key: "received", label: "Units received", sql: "COALESCE(sum(b.on_hand_delta) FILTER (WHERE b.reason = 'RECEIPT'), 0)", format: "count", apply: { type: "RECEIPT" } },
    { key: "sold", label: "Units sold", sql: "COALESCE(-sum(b.on_hand_delta) FILTER (WHERE b.reason IN ('COUNTER_SALE', 'ONLINE_FULFIL')), 0)", format: "count", apply: { type: "COUNTER_SALE,ONLINE_FULFIL" } },
    { key: "returned", label: "Units returned", sql: "COALESCE(sum(b.on_hand_delta) FILTER (WHERE b.reason = 'RETURN'), 0)", format: "count", apply: { type: "RETURN" } },
    { key: "adjusted", label: "Adjustments", sql: "count(*) FILTER (WHERE b.reason = 'ADJUSTMENT')", format: "count", apply: { type: "ADJUSTMENT" } },
  ],
  csv: [
    { key: "created_at", label: "When", format: "datetime" }, { key: "product", label: "Product" }, { key: "label", label: "Variant" }, { key: "sku", label: "SKU" },
    { key: "reason", label: "Movement" }, { key: "on_hand_delta", label: "On hand change" }, { key: "reserved_delta", label: "Reserved change" },
    { key: "unit_cost", label: "Unit cost (₹)", format: "money" }, { key: "ref_code", label: "Reference" }, { key: "note", label: "Note" }, { key: "actor_name", label: "By" },
  ],
};
