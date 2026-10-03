// v3 §5.1 / v4 §2: every drawer session (Owner, Manager, Accountant) — staff, till, status, date, variance ≠ 0 — with
// collections by method; and v4 §2.4 the signed-in staff member's drawer movements (running balance per row).
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
    SELECT d.id, d.user_id, u.name, d.area, d.drawer_id, COALESCE(t.name, initcap(d.area) || ' drawer') AS drawer_name, d.status, d.variance_reason,
      d.float_carried, d.cash_dropped, d.opened_at, d.closed_at, d.opening_float,
      ${Prisma.raw(sumBy("CASH", "PAYMENT"))} AS cash_in, ${Prisma.raw(sumBy("CASH", "REFUND"))} AS cash_out,
      ${Prisma.raw(countBy("CASH"))} AS cash_n, ${Prisma.raw(countBy("UPI"))} AS upi_n, ${Prisma.raw(countBy("CARD"))} AS card_n, ${Prisma.raw(countBy("ONLINE"))} AS online_n,
      ${Prisma.raw(sumBy("UPI", "REFUND"))} AS upi_out, ${Prisma.raw(sumBy("CARD", "REFUND"))} AS card_out, ${Prisma.raw(sumBy("ONLINE", "REFUND"))} AS online_out,
      ${Prisma.raw(sumBy("UPI", "PAYMENT"))} AS upi, ${Prisma.raw(sumBy("CARD", "PAYMENT"))} AS card, ${Prisma.raw(sumBy("ONLINE", "PAYMENT"))} AS online,
      COALESCE(d.cash_expected, (SELECT m.balance_after FROM drawer_movements m WHERE m.session_id = d.id ORDER BY m.line_no DESC LIMIT 1), d.opening_float) AS cash_expected,
      d.cash_counted, d.variance, d.deposit_amount, d.note,
      CASE WHEN d.closed_at IS NULL THEN 'OPEN' ELSE 'CLOSED' END AS state
    FROM cash_drawer_sessions d JOIN users u ON u.id = d.user_id LEFT JOIN cash_drawers t ON t.id = d.drawer_id`,
  search: ["b.name", "b.drawer_name"],
  dateColumn: { expr: "b.opened_at", label: "Opened", kind: "timestamp" },
  facets: [
    { key: "staff", label: "Staff", expr: "b.user_id", labelsSql: "SELECT id AS value, name AS label FROM users WHERE role <> 'MEMBER'" },
    { key: "area", label: "Drawer", expr: "b.area", options: [{ value: "DESK", label: "Front desk" }, { value: "SHOP", label: "Shop" }, { value: "BAR", label: "Bar" }, { value: "OFFICE", label: "Office" }] },
    { key: "till", label: "Till", expr: "b.drawer_id", labelsSql: "SELECT id AS value, name AS label FROM cash_drawers" },
    { key: "state", label: "State", expr: "b.state", options: [{ value: "OPEN", label: "Open now" }, { value: "CLOSED", label: "Closed" }] },
    {
      key: "status", label: "Status", expr: "b.status",
      options: [{ value: "OPEN", label: "Open" }, { value: "PENDING_APPROVAL", label: "Variance awaiting approval" }, { value: "CLOSED", label: "Closed" }, { value: "APPROVED", label: "Variance approved" }, { value: "REJECTED", label: "Variance rejected" }],
    },
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
    { key: "pending", label: "Awaiting approval", sql: "count(*) FILTER (WHERE b.status = 'PENDING_APPROVAL')", format: "count", apply: { status: "PENDING_APPROVAL" } },
  ],
  csv: [
    { key: "name", label: "Staff" }, { key: "drawer_name", label: "Till" }, { key: "status", label: "Status" }, { key: "opened_at", label: "Opened", format: "datetime" }, { key: "closed_at", label: "Closed", format: "datetime" },
    { key: "opening_float", label: "Float (₹)", format: "money" }, { key: "cash_in", label: "Cash taken (₹)", format: "money" }, { key: "cash_out", label: "Cash refunded (₹)", format: "money" },
    { key: "cash_expected", label: "Cash expected (₹)", format: "money" }, { key: "cash_counted", label: "Cash counted (₹)", format: "money" }, { key: "variance", label: "Variance (₹)", format: "money" },
    { key: "upi", label: "UPI (₹)", format: "money" }, { key: "card", label: "Card (₹)", format: "money" }, { key: "online", label: "Online (₹)", format: "money" },
  ],
  defaults: () => ({ range: "TODAY" }),
};

const MOVEMENT_OPTIONS = [
  { value: "OPENING_FLOAT", label: "Opening float" }, { value: "CASH_SALE", label: "Cash sale" }, { value: "CASH_REFUND", label: "Cash refund" },
  { value: "PAY_IN", label: "Pay in" }, { value: "PAY_OUT", label: "Pay out" }, { value: "CASH_DROP", label: "Cash drop" }, { value: "CLOSING_ADJUSTMENT", label: "Closing adjustment" },
];

/**
 * v4 §2.4 "My Cash Drawer": the movements of the signed-in staff member's drawer — the open session, or the last one
 * after closing — with the running balance and what each row points at (bill, refund, expense).
 */
export const myDrawerMovementsList: ListDef = {
  name: "my-drawer-movements",
  title: "My cash drawer",
  view: ["staff.self"],
  exportCaps: ["staff.self"],
  base: (ctx) => Prisma.sql`
    SELECT m.id, m.session_id, m.line_no, m.type, m.amount, m.balance_after, m.at, m.at_close, m.reference, m.category, m.note,
      m.payment_id, m.expense_id, p.bill_id, bl.customer_name AS customer, bl.source_type::text AS source, rr.code AS refund_code, e.vendor AS expense_vendor
    FROM drawer_movements m
    LEFT JOIN payments p ON p.id = m.payment_id
    LEFT JOIN bills bl ON bl.id = p.bill_id
    LEFT JOIN refund_requests rr ON rr.id = p.refund_request_id
    LEFT JOIN expense_bills e ON e.id = m.expense_id
    WHERE m.session_id = (SELECT s.id FROM cash_drawer_sessions s WHERE s.user_id = ${ctx.userId ?? "—"} ORDER BY (s.closed_at IS NULL) DESC, s.opened_at DESC LIMIT 1)`,
  search: ["b.customer", "b.reference", "b.note", "b.refund_code"],
  dateColumn: { expr: "b.at", label: "Time", kind: "timestamp" },
  facets: [{ key: "type", label: "Type", expr: "b.type", options: MOVEMENT_OPTIONS }],
  sorts: {
    newest: { label: "Newest first", sql: "b.line_no DESC" },
    oldest: { label: "Oldest first", sql: "b.line_no ASC" },
    amount: { label: "Largest amount", sql: "abs(b.amount) DESC, b.line_no DESC" },
  },
  defaultSort: "newest",
  summary: [],
  csv: [
    { key: "line_no", label: "#" }, { key: "at", label: "Time", format: "datetime" }, { key: "type", label: "Type" }, { key: "customer", label: "Customer" },
    { key: "reference", label: "Reference" }, { key: "amount", label: "Amount (₹)", format: "money" }, { key: "balance_after", label: "Balance (₹)", format: "money" }, { key: "note", label: "Note" },
  ],
};
