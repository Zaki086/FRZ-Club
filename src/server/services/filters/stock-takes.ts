// v3 §3.2: stock takes — each count with what was expected, what was counted and the differences posted.
// A stock take is posted in one go (no drafts), so its "status" is whether the count matched the system.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const stockTakesList: ListDef = {
  name: "stock-takes",
  title: "Stock takes",
  view: ["shop.stock"],
  exportCaps: ["shop.stock", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT st.id, st.code, st.note, st.posted_at, st.created_by, u.name AS created_by_name,
      COALESCE(x.counted, 0) AS counted, COALESCE(x.changed, 0) AS changed, COALESCE(x.short, 0) AS short, COALESCE(x.surplus, 0) AS surplus,
      CASE WHEN COALESCE(x.changed, 0) > 0 THEN 'ADJUSTED' ELSE 'MATCHED' END AS status,
      COALESCE((SELECT json_agg(json_build_object('id', l.id, 'sku', COALESCE(v.sku, ''), 'expected', l.expected, 'counted', l.counted, 'delta', l.delta,
                  'name', COALESCE(p.name || CASE WHEN v.label <> 'Standard' THEN ' — ' || v.label ELSE '' END, '?')) ORDER BY l.delta = 0, p.name, l.id)
                  FROM stock_take_lines l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
                 WHERE l.stock_take_id = st.id), '[]'::json) AS lines
    FROM stock_takes st
    LEFT JOIN users u ON u.id = st.created_by
    LEFT JOIN LATERAL (SELECT count(*)::int AS counted, count(*) FILTER (WHERE l.delta <> 0)::int AS changed,
                              COALESCE(-sum(l.delta) FILTER (WHERE l.delta < 0), 0)::int AS short, COALESCE(sum(l.delta) FILTER (WHERE l.delta > 0), 0)::int AS surplus
                         FROM stock_take_lines l WHERE l.stock_take_id = st.id) x ON TRUE`,
  search: ["b.code", "b.note", "b.created_by_name"],
  dateColumn: { expr: "b.posted_at", label: "Posted", kind: "timestamp" },
  facets: [
    { key: "status", label: "Result", expr: "b.status", options: [{ value: "ADJUSTED", label: "Differences posted" }, { value: "MATCHED", label: "All matched" }] },
    { key: "staff", label: "Counted by", expr: "b.created_by", meAlias: true, labelsSql: "SELECT id AS value, name AS label FROM users" },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.posted_at DESC" },
    oldest: { label: "Oldest first", sql: "b.posted_at ASC" },
    changed: { label: "Most differences", sql: "b.changed DESC, b.posted_at DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "takes", label: "Stock takes", sql: "count(*)", format: "count", apply: {} },
    { key: "adjusted", label: "With differences", sql: "count(*) FILTER (WHERE b.status = 'ADJUSTED')", format: "count", apply: { status: "ADJUSTED" } },
    { key: "short", label: "Units short", sql: "COALESCE(sum(b.short), 0)", format: "count", apply: { status: "ADJUSTED" } },
    { key: "surplus", label: "Units over", sql: "COALESCE(sum(b.surplus), 0)", format: "count", apply: { status: "ADJUSTED" } },
  ],
  csv: [
    { key: "code", label: "Stock take" }, { key: "posted_at", label: "Posted", format: "datetime" }, { key: "created_by_name", label: "Counted by" },
    { key: "counted", label: "Items counted" }, { key: "changed", label: "Items adjusted" }, { key: "short", label: "Units short" }, { key: "surplus", label: "Units over" }, { key: "note", label: "Note" },
  ],
};
