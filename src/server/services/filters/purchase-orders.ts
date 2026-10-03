// v3 §3.2: purchase orders (DRAFT → ORDERED → RECEIVED, or CANCELLED) with their lines and value.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const purchaseOrdersList: ListDef = {
  name: "purchase-orders",
  title: "Purchase orders",
  view: ["shop.view"],
  exportCaps: ["shop.stock", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT po.id, po.code, po.supplier, po.status, po.note, po.created_at, po.ordered_at, po.received_at, po.expense_id, po.created_by, u.name AS created_by_name,
      COALESCE((SELECT sum(l.qty::bigint * l.unit_cost) FROM purchase_order_lines l WHERE l.po_id = po.id), 0)::bigint AS total,
      COALESCE((SELECT sum(l.qty) FROM purchase_order_lines l WHERE l.po_id = po.id), 0)::int AS units,
      COALESCE((SELECT json_agg(json_build_object('id', l.id, 'variantId', l.variant_id, 'qty', l.qty, 'unitCost', l.unit_cost, 'sku', COALESCE(v.sku, ''),
                  'name', COALESCE(p.name || CASE WHEN v.label <> 'Standard' THEN ' — ' || v.label ELSE '' END, '?')) ORDER BY l.created_at, l.id)
                  FROM purchase_order_lines l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
                 WHERE l.po_id = po.id), '[]'::json) AS lines,
      (SELECT string_agg(p.name || ' ' || v.sku, ' ') FROM purchase_order_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.po_id = po.id) AS items_text
    FROM purchase_orders po LEFT JOIN users u ON u.id = po.created_by`,
  search: ["b.code", "b.supplier", "b.note", "b.items_text"],
  dateColumn: { expr: "b.created_at", label: "Created", kind: "timestamp" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "DRAFT", label: "Draft" }, { value: "ORDERED", label: "Ordered" }, { value: "RECEIVED", label: "Received" }, { value: "CANCELLED", label: "Cancelled" },
    ] },
    { key: "supplier", label: "Supplier", expr: "b.supplier" },
  ],
  sorts: {
    stage: { label: "To do first", sql: "CASE b.status WHEN 'DRAFT' THEN 0 WHEN 'ORDERED' THEN 1 ELSE 2 END, b.created_at DESC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    total: { label: "Largest first", sql: "b.total DESC, b.created_at DESC" },
  },
  defaultSort: "stage",
  summary: [
    { key: "drafts", label: "Drafts", sql: "count(*) FILTER (WHERE b.status = 'DRAFT')", format: "count", apply: { status: "DRAFT" } },
    { key: "ordered", label: "Awaiting delivery", sql: "count(*) FILTER (WHERE b.status = 'ORDERED')", format: "count", apply: { status: "ORDERED" } },
    { key: "on_order", label: "Value on order", sql: "COALESCE(sum(b.total) FILTER (WHERE b.status = 'ORDERED'), 0)", format: "money", apply: { status: "ORDERED" } },
    { key: "received", label: "Received", sql: "count(*) FILTER (WHERE b.status = 'RECEIVED')", format: "count", apply: { status: "RECEIVED" } },
  ],
  csv: [
    { key: "code", label: "Order" }, { key: "created_at", label: "Created", format: "datetime" }, { key: "supplier", label: "Supplier" }, { key: "status", label: "Status" },
    { key: "units", label: "Units" }, { key: "total", label: "Total (₹)", format: "money" }, { key: "items_text", label: "Items" },
    { key: "ordered_at", label: "Ordered", format: "datetime" }, { key: "received_at", label: "Received", format: "datetime" }, { key: "created_by_name", label: "Created by" }, { key: "note", label: "Note" },
  ],
};
