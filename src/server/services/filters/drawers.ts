// v3 §5.1: every drawer session (Owner, Manager, Accountant) — staff, date, variance ≠ 0 — with collections by method.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const countBy = (method: string) =>
  `(SELECT count(*) FROM payments p WHERE p.drawer_session_id = d.id AND p.status = 'SUCCEEDED' AND p.method = '${method}' AND p.type = 'PAYMENT')::int`;
const sumBy = (method: string, type: string) =>
  `COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.drawer_session_id = d.id AND p.status = 'SUCCEEDED' AND p.method = '${method}' AND p.type = '${type}'), 0)::int`;

export const drawersList: ListDef = {
  name: "drawers",
  title: "Cash drawers",
  view: ["cash.reconcile", "dashboard.ops"],
  exportCaps: ["cash.reconcile", "dashboard.ops"],
  base: () => Prisma.sql`
    SELECT d.id, d.user_id, u.name, d.area, d.opened_at, d.closed_at, d.opening_float,
      ${Prisma.raw(sumBy("CASH", "PAYMENT"))} AS cash_in, ${Prisma.raw(sumBy("CASH", "REFUND"))} AS cash_out,
      ${Prisma.raw(countBy("CASH"))} AS cash_n, ${Prisma.raw(countBy("UPI"))} AS upi_n, ${Prisma.raw(countBy("CARD"))} AS card_n, ${Prisma.raw(countBy("ONLINE"))} AS online_n,
      ${Prisma.raw(sumBy("UPI", "REFUND"))} AS upi_out, ${Prisma.raw(sumBy("CARD", "REFUND"))} AS card_out, ${Prisma.raw(sumBy("ONLINE", "REFUND"))} AS online_out,
      ${Prisma.raw(sumBy("UPI", "PAYMENT"))} AS upi, ${Prisma.raw(sumBy("CARD", "PAYMENT"))} AS card, ${Prisma.raw(sumBy("ONLINE", "PAYMENT"))} AS online,
      COALESCE(d.cash_expected, d.opening_float + ${Prisma.raw(sumBy("CASH", "PAYMENT"))} - ${Prisma.raw(sumBy("CASH", "REFUND"))}) AS cash_expected,
      d.cash_counted, d.variance, d.deposit_amount, d.note,
      CASE WHEN d.closed_at IS NULL THEN 'OPEN' ELSE 'CLOSED' END AS state
    FROM cash_drawer_sessions d JOIN users u ON u.id = d.user_id`,
  search: ["b.name"],
  dateColumn: { expr: "b.opened_at", label: "Opened", kind: "timestamp" },
  facets: [
    { key: "staff", label: "Staff", expr: "b.user_id", labelsSql: "SELECT id AS value, name AS label FROM users WHERE role <> 'MEMBER'" },
    { key: "area", label: "Drawer", expr: "b.area", options: [{ value: "DESK", label: "Front desk" }, { value: "SHOP", label: "Shop" }, { value: "BAR", label: "Bar" }, { value: "OFFICE", label: "Office" }] },
    { key: "state", label: "State", expr: "b.state", options: [{ value: "OPEN", label: "Open now" }, { value: "CLOSED", label: "Closed" }] },
    { key: "variance", label: "Variance", expr: "CASE WHEN COALESCE(b.variance, 0) <> 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Variance ≠ 0" }, { value: "no", label: "No variance" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.opened_at DESC" },
    variance: { label: "Largest variance", sql: "abs(COALESCE(b.variance, 0)) DESC, b.opened_at DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "open", label: "Open now", sql: "count(*) FILTER (WHERE b.state = 'OPEN')", format: "count", apply: { state: "OPEN" } },
    { key: "collected", label: "Collected (all methods)", sql: "COALESCE(sum(b.cash_in + b.upi + b.card + b.online), 0)", format: "money", apply: {} },
    { key: "variances", label: "Sessions with a variance", sql: "count(*) FILTER (WHERE COALESCE(b.variance, 0) <> 0)", format: "count", apply: { variance: "yes" } },
    { key: "net", label: "Net variance", sql: "COALESCE(sum(b.variance), 0)", format: "money", apply: { variance: "yes" } },
  ],
  csv: [
    { key: "name", label: "Staff" }, { key: "area", label: "Drawer" }, { key: "opened_at", label: "Opened", format: "datetime" }, { key: "closed_at", label: "Closed", format: "datetime" },
    { key: "opening_float", label: "Float (₹)", format: "money" }, { key: "cash_in", label: "Cash taken (₹)", format: "money" }, { key: "cash_out", label: "Cash refunded (₹)", format: "money" },
    { key: "cash_expected", label: "Cash expected (₹)", format: "money" }, { key: "cash_counted", label: "Cash counted (₹)", format: "money" }, { key: "variance", label: "Variance (₹)", format: "money" },
    { key: "upi", label: "UPI (₹)", format: "money" }, { key: "card", label: "Card (₹)", format: "money" }, { key: "online", label: "Online (₹)", format: "money" },
  ],
  defaults: () => ({ range: "TODAY" }),
};
