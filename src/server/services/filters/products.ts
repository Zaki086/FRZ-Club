// v3 §9.3: the product list with the standard FilterBar — category, brand, Active/Archived, low stock, has promotion,
// price range. Stock figures are read-only here.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const CATEGORY = [
  { value: "RACKETS", label: "Rackets" }, { value: "BALLS", label: "Balls" }, { value: "SHOES", label: "Shoes" },
  { value: "ACCESSORIES", label: "Accessories" }, { value: "APPAREL", label: "Apparel" }, { value: "SERVICES", label: "Services" },
];

export const productsList: ListDef = {
  name: "products",
  title: "Products",
  view: ["shop.view"],
  exportCaps: ["shop.stock", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT p.id, p.name, p.brand, p.category::text AS category, p.image_url, p.is_restring, p.track_stock, p.created_at,
      CASE WHEN p.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END AS status,
      v.variants, v.min_price, v.max_price, v.on_hand, v.available, v.low,
      (SELECT pi.thumb_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort LIMIT 1) AS thumb,
      EXISTS (SELECT 1 FROM price_rules r WHERE r.kind = 'PROMOTION' AND r.scope = 'PRODUCTS' AND r.status = 'ACTIVE'
                AND r.effective_from <= app_now() AND (r.effective_to IS NULL OR r.effective_to > app_now())
                AND (r.date_to IS NULL OR r.date_to >= (app_now() AT TIME ZONE 'Asia/Kolkata')::date)
                AND ((cardinality(r.product_ids) = 0 AND cardinality(r.product_categories) = 0) OR p.id = ANY(r.product_ids) OR p.category::text = ANY(r.product_categories))) AS has_promotion
    FROM products p
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE pv.archived_at IS NULL)::int AS variants,
             min(pv.price) FILTER (WHERE pv.archived_at IS NULL) AS min_price, max(pv.price) FILTER (WHERE pv.archived_at IS NULL) AS max_price,
             COALESCE(sum(pv.on_hand), 0)::int AS on_hand, COALESCE(sum(pv.on_hand - pv.reserved), 0)::int AS available,
             bool_or(p.track_stock AND pv.archived_at IS NULL AND pv.on_hand - pv.reserved <= pv.reorder_level) AS low
        FROM product_variants pv WHERE pv.product_id = p.id) v ON TRUE`,
  search: ["b.name", "b.brand", "(SELECT string_agg(sku, ' ') FROM product_variants WHERE product_id = b.id)"],
  facets: [
    { key: "category", label: "Category", expr: "b.category", options: CATEGORY },
    { key: "brand", label: "Brand", expr: "NULLIF(b.brand, '')" },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "ACTIVE", label: "Active" }, { value: "ARCHIVED", label: "Archived" }] },
    { key: "low", label: "Low stock", expr: "CASE WHEN COALESCE(b.low, false) THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Low stock" }, { value: "no", label: "Stock OK" }] },
    { key: "promo", label: "Promotion", expr: "CASE WHEN b.has_promotion THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has a promotion" }, { value: "no", label: "No promotion" }] },
    { key: "price", label: "Price", expr: "CASE WHEN b.min_price IS NULL THEN 'none' WHEN b.min_price < 50000 THEN 'lt500' WHEN b.min_price < 200000 THEN '500-2000' WHEN b.min_price < 500000 THEN '2000-5000' ELSE 'gt5000' END", options: [
      { value: "lt500", label: "Under ₹500" }, { value: "500-2000", label: "₹500 – ₹2,000" }, { value: "2000-5000", label: "₹2,000 – ₹5,000" }, { value: "gt5000", label: "₹5,000 and up" },
    ] },
  ],
  sorts: {
    name: { label: "Name", sql: "b.name ASC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    price: { label: "Price", sql: "b.min_price ASC NULLS LAST, b.name" },
    stock: { label: "Least stock", sql: "b.available ASC, b.name" },
  },
  defaultSort: "name",
  summary: [
    { key: "active", label: "Active products", sql: "count(*) FILTER (WHERE b.status = 'ACTIVE')", format: "count", apply: { status: "ACTIVE" } },
    { key: "low", label: "Low on stock", sql: "count(*) FILTER (WHERE COALESCE(b.low, false) AND b.status = 'ACTIVE')", format: "count", apply: { low: "yes", status: "ACTIVE" } },
    { key: "promo", label: "On promotion", sql: "count(*) FILTER (WHERE b.has_promotion AND b.status = 'ACTIVE')", format: "count", apply: { promo: "yes", status: "ACTIVE" } },
    { key: "archived", label: "Archived", sql: "count(*) FILTER (WHERE b.status = 'ARCHIVED')", format: "count", apply: { status: "ARCHIVED" } },
  ],
  csv: [
    { key: "name", label: "Product" }, { key: "brand", label: "Brand" }, { key: "category", label: "Category" }, { key: "status", label: "Status" },
    { key: "variants", label: "Variants" }, { key: "min_price", label: "From (₹)", format: "money" }, { key: "max_price", label: "To (₹)", format: "money" },
    { key: "on_hand", label: "On hand" }, { key: "available", label: "Available" },
  ],
  defaults: () => ({ status: "ACTIVE" }),
};
