// v3 §3.2: every bar tab — open, carried over, settled, void — with table, payer, bar day and what is still due.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const tabsList: ListDef = {
  name: "tabs",
  title: "Bar tabs",
  // The same people who could open a tab screen (bar.operate) or the bar day report (bar.report).
  view: ["bar.operate", "bar.report"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT t.id, t.code, t.status::text AS status, t.table_id, bt.number AS table_number, COALESCE(t.table_id, 'counter') AS place,
      t.member_id, t.guest_id, COALESCE(m.name, g.name, bl.customer_name) AS payer, COALESCE(m.phone, g.phone) AS phone, m.member_code,
      CASE WHEN t.member_id IS NOT NULL THEN 'member' ELSE 'guest' END AS who,
      bl.tier, bl.total, bl.discount_total AS discount, (bl.amount_paid - bl.amount_refunded) AS paid,
      CASE WHEN bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END AS due,
      t.bar_date, to_char(t.bar_date, 'YYYY-MM-DD') AS bar_day, t.created_at AS opened_at, t.settled_at,
      t.carried_reason, ou.name AS opened_by_name, cu.name AS carried_by_name, t.guest_id_verified,
      COALESCE(ln.items, 0) AS items, ln.summary
    FROM tabs t
    JOIN bills bl ON bl.id = t.bill_id
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN guests g ON g.id = t.guest_id
    LEFT JOIN bar_tables bt ON bt.id = t.table_id
    LEFT JOIN users ou ON ou.id = t.opened_by
    LEFT JOIN users cu ON cu.id = t.carried_by
    LEFT JOIN LATERAL (SELECT sum(l.qty) FILTER (WHERE l.status <> 'VOID')::int AS items,
                              string_agg(l.qty || ' × ' || mi.name, ', ' ORDER BY l.created_at) FILTER (WHERE l.status <> 'VOID') AS summary
                         FROM tab_lines l JOIN menu_items mi ON mi.id = l.menu_item_id WHERE l.tab_id = t.id) ln ON TRUE`,
  search: ["b.code", "b.payer", "b.phone", "b.member_code"],
  dateColumn: { expr: "b.bar_date", label: "Bar day", kind: "date" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "OPEN", label: "Open" }, { value: "CARRIED", label: "Carried over" }, { value: "SETTLED", label: "Settled" }, { value: "VOID", label: "Void" },
    ] },
    { key: "table", label: "Table", expr: "b.place", labelsSql: "SELECT id AS value, 'Table ' || number AS label FROM bar_tables UNION ALL SELECT 'counter', 'Bar counter (no table)'" },
    { key: "who", label: "Member or guest", expr: "b.who", options: [{ value: "member", label: "Member" }, { value: "guest", label: "Guest" }] },
    { key: "due", label: "Balance", expr: "CASE WHEN b.due > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Still to pay" }, { value: "no", label: "Nothing due" }] },
  ],
  sorts: {
    todo: { label: "Open first", sql: "CASE b.status WHEN 'OPEN' THEN 0 WHEN 'CARRIED' THEN 1 ELSE 2 END, b.opened_at DESC" },
    newest: { label: "Newest first", sql: "b.opened_at DESC" },
    due: { label: "Most due", sql: "b.due DESC, b.opened_at DESC" },
    total: { label: "Largest bill", sql: "b.total DESC, b.opened_at DESC" },
  },
  defaultSort: "todo",
  summary: [
    { key: "open", label: "Open tabs", sql: "count(*) FILTER (WHERE b.status = 'OPEN')", format: "count", apply: { status: "OPEN" } },
    { key: "open_due", label: "Due on open tabs", sql: "COALESCE(sum(b.due) FILTER (WHERE b.status = 'OPEN'), 0)", format: "money", apply: { status: "OPEN", due: "yes" } },
    { key: "carried_due", label: "Carried over, due", sql: "COALESCE(sum(b.due) FILTER (WHERE b.status = 'CARRIED'), 0)", format: "money", apply: { status: "CARRIED" } },
    {
      key: "settled_today", label: "Settled today",
      sql: "COALESCE(sum(b.total) FILTER (WHERE b.status = 'SETTLED' AND (b.settled_at AT TIME ZONE 'Asia/Kolkata')::date = (app_now() AT TIME ZONE 'Asia/Kolkata')::date), 0)",
      format: "money", apply: { status: "SETTLED", range: "TODAY" },
    },
  ],
  csv: [
    { key: "code", label: "Tab" }, { key: "bar_day", label: "Bar day" }, { key: "payer", label: "Payer" }, { key: "who", label: "Member/guest" },
    { key: "table_number", label: "Table" }, { key: "status", label: "Status" }, { key: "items", label: "Items" },
    { key: "total", label: "Total (₹)", format: "money" }, { key: "paid", label: "Paid (₹)", format: "money" }, { key: "due", label: "Due (₹)", format: "money" },
    { key: "opened_at", label: "Opened", format: "datetime" }, { key: "opened_by_name", label: "Opened by" }, { key: "settled_at", label: "Settled", format: "datetime" },
    { key: "carried_reason", label: "Carried over because" },
  ],
};
