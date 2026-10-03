// v3 §3.2: every bar day — today, every day a tab was opened, every closed day — with what it collected, its tabs,
// whether it is closed, and the bar cash drawers' variance (counted − expected) for drawers opened that day.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const IST_DAY = (col: string) => `(${col}::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const IST_NEXT = (col: string) => `((${col} + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

export const barDaysList: ListDef = {
  name: "bar-days",
  title: "Bar days",
  view: ["bar.report"],
  exportCaps: ["dashboard.ops"],
  base: (ctx) => Prisma.sql`
    WITH days AS (
      SELECT DISTINCT bar_date AS d FROM tabs
      UNION SELECT date FROM bar_days
      UNION SELECT ${ctx.today}::date
    )
    SELECT to_char(x.d, 'YYYY-MM-DD') AS id, x.d AS date,
      CASE WHEN bd.id IS NULL THEN 'OPEN' ELSE 'CLOSED' END AS status,
      bd.closed_at, cu.name AS closed_by_name,
      COALESCE(tb.opened, 0) AS tabs_opened, COALESCE(tb.settled, 0) AS tabs_settled, COALESCE(tb.carried, 0) AS tabs_carried,
      COALESCE(tb.still_open, 0) AS tabs_open,
      (SELECT count(*) FROM tabs o WHERE o.status = 'OPEN' AND o.bar_date <= x.d)::int AS blocking,
      COALESCE(lg.collected, 0) AS collected,
      dv.variance, COALESCE(dv.drawers, 0) AS drawers
    FROM days x
    LEFT JOIN bar_days bd ON bd.date = x.d
    LEFT JOIN users cu ON cu.id = bd.closed_by
    LEFT JOIN LATERAL (SELECT count(*)::int AS opened, count(*) FILTER (WHERE t.status = 'SETTLED')::int AS settled,
                              count(*) FILTER (WHERE t.status = 'CARRIED')::int AS carried, count(*) FILTER (WHERE t.status = 'OPEN')::int AS still_open
                         FROM tabs t WHERE t.bar_date = x.d) tb ON TRUE
    LEFT JOIN LATERAL (SELECT sum(le.amount)::int AS collected FROM ledger_entries le
                        WHERE le.source = 'BAR' AND le.occurred_at >= ${Prisma.raw(IST_DAY("x.d"))} AND le.occurred_at < ${Prisma.raw(IST_NEXT("x.d"))}) lg ON TRUE
    LEFT JOIN LATERAL (SELECT sum(cd.variance)::int AS variance, count(*)::int AS drawers FROM cash_drawer_sessions cd
                        WHERE cd.area = 'BAR' AND cd.closed_at IS NOT NULL
                          AND cd.opened_at >= ${Prisma.raw(IST_DAY("x.d"))} AND cd.opened_at < ${Prisma.raw(IST_NEXT("x.d"))}) dv ON TRUE`,
  search: ["b.id", "b.closed_by_name"],
  dateColumn: { expr: "b.date", label: "Bar day", kind: "date" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "OPEN", label: "Not closed" }, { value: "CLOSED", label: "Closed" }] },
    { key: "variance", label: "Variance", expr: "CASE WHEN COALESCE(b.variance, 0) <> 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Variance ≠ 0" }, { value: "no", label: "No variance" }] },
    { key: "carried", label: "Carried tabs", expr: "CASE WHEN b.tabs_carried > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has carried tabs" }, { value: "no", label: "None carried" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.date DESC" },
    oldest: { label: "Oldest first", sql: "b.date ASC" },
    collected: { label: "Most collected", sql: "b.collected DESC, b.date DESC" },
    variance: { label: "Largest variance", sql: "abs(COALESCE(b.variance, 0)) DESC, b.date DESC" },
  },
  defaultSort: "newest",
  summary: [
    { key: "open", label: "Days not closed", sql: "count(*) FILTER (WHERE b.status = 'OPEN')", format: "count", apply: { status: "OPEN" } },
    { key: "collected", label: "Collected (net)", sql: "COALESCE(sum(b.collected), 0)", format: "money", apply: {} },
    { key: "variance_days", label: "Days with a variance", sql: "count(*) FILTER (WHERE COALESCE(b.variance, 0) <> 0)", format: "count", apply: { variance: "yes" } },
    { key: "variance", label: "Net cash variance", sql: "COALESCE(sum(b.variance), 0)", format: "money", apply: { variance: "yes" } },
  ],
  csv: [
    { key: "id", label: "Bar day" }, { key: "status", label: "Status" }, { key: "collected", label: "Collected (₹)", format: "money" },
    { key: "tabs_opened", label: "Tabs opened" }, { key: "tabs_settled", label: "Tabs settled" }, { key: "tabs_carried", label: "Tabs carried" },
    { key: "tabs_open", label: "Tabs still open" }, { key: "variance", label: "Bar drawer variance (₹)", format: "money" },
    { key: "closed_at", label: "Closed", format: "datetime" }, { key: "closed_by_name", label: "Closed by" },
  ],
};
