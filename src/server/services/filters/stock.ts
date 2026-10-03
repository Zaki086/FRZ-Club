// v3 §3.2: stock per variant (one shelf for counter and online; available = on hand − reserved).
// `/app/shop/stock?filter=low` (notifications, dashboard) is the `filter` facet with the value `low`.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const CATEGORY = [
  { value: "RACKETS", label: "Rackets" }, { value: "BALLS", label: "Balls" }, { value: "SHOES", label: "Shoes" },
  { value: "ACCESSORIES", label: "Accessories" }, { value: "APPAREL", label: "Apparel" }, { value: "SERVICES", label: "Services" },
];

export const stockList: ListDef = {
  name: "stock",
  title: "Stock",
  view: ["shop.view"],
  exportCaps: ["shop.stock", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT x.*,
      (x.track_stock AND NOT x.archived AND x.available <= x.reorder_level) AS low,
      (x.track_stock AND NOT x.archived AND x.available <= 0) AS out_of_stock
    FROM (
      SELECT v.id, v.id AS variant_id, v.sku, v.barcode, v.label, v.price, v.on_hand, v.reserved, v.on_hand - v.reserved AS available, v.reorder_level,
        p.id AS product_id, p.name AS product, p.brand, p.category::text AS category, p.image_url, p.track_stock,
        (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived
      FROM product_variants v JOIN products p ON p.id = v.product_id
    ) x`,
  search: ["b.product", "b.sku", "b.barcode", "b.brand", "b.label"],
  facets: [
    { key: "category", label: "Category", expr: "b.category", options: CATEGORY },
    { key: "filter", label: "Stock level", expr: "array_remove(ARRAY[CASE WHEN b.low THEN 'low' END, CASE WHEN b.out_of_stock THEN 'out' END, CASE WHEN b.track_stock AND NOT b.low THEN 'ok' END], NULL)", multi: true, options: [
      { value: "low", label: "Low stock" }, { value: "out", label: "Out of stock" }, { value: "ok", label: "Stock OK" },
    ] },
    { key: "track", label: "Stock tracking", expr: "CASE WHEN b.track_stock THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Goods (counted)" }, { value: "no", label: "Services (not counted)" }] },
    { key: "archived", label: "Archived", expr: "CASE WHEN b.archived THEN 'yes' ELSE 'no' END", options: [{ value: "no", label: "On sale" }, { value: "yes", label: "Archived" }] },
  ],
  sorts: {
    category: { label: "Category, then name", sql: "b.category ASC, b.product ASC, b.label ASC" },
    name: { label: "Name", sql: "b.product ASC, b.label ASC" },
    available: { label: "Least available", sql: "b.track_stock DESC, b.available ASC, b.product ASC" },
    reorder: { label: "Furthest below reorder", sql: "b.track_stock DESC, (b.available - b.reorder_level) ASC, b.product ASC" },
  },
  defaultSort: "category",
  defaults: () => ({ archived: "no" }),
  summary: [
    { key: "items", label: "Items on sale", sql: "count(*) FILTER (WHERE NOT b.archived)", format: "count", apply: { archived: "no" } },
    { key: "low", label: "Low on stock", sql: "count(*) FILTER (WHERE b.low)", format: "count", apply: { filter: "low" } },
    { key: "out", label: "Out of stock", sql: "count(*) FILTER (WHERE b.out_of_stock)", format: "count", apply: { filter: "out" } },
    { key: "value", label: "Shelf value (at sale price)", sql: "COALESCE(sum(b.on_hand::bigint * b.price) FILTER (WHERE b.track_stock AND NOT b.archived), 0)::bigint", format: "money", apply: {} },
  ],
  csv: [
    { key: "product", label: "Product" }, { key: "label", label: "Variant" }, { key: "sku", label: "SKU" }, { key: "barcode", label: "Barcode" }, { key: "category", label: "Category" },
    { key: "price", label: "Price (₹)", format: "money" }, { key: "on_hand", label: "On hand" }, { key: "reserved", label: "Reserved" }, { key: "available", label: "Available" },
    { key: "reorder_level", label: "Reorder level" }, { key: "low", label: "Low" }, { key: "archived", label: "Archived" },
  ],
};
