// v3 §3.2: the audit log (Owner). The table grows without limit, so the date range is applied inside the base and
// the list opens on the last 7 days; the before/after snapshots are not copied into the list — a row loads them
// when it is opened (`/api/audit?entity=…&entityId=…`).
import { Prisma } from "@prisma/client";
import { istDayRange } from "@/lib/time";
import type { ListDef } from "./core";

const ACTOR = "COALESCE(b.actor_id, CASE WHEN b.actor_label = 'public website' THEN 'public' ELSE 'system' END)";
const TODAY = "(app_now() AT TIME ZONE 'Asia/Kolkata')::date";

export const auditList: ListDef = {
  name: "audit",
  title: "Audit log",
  view: ["audit"],
  exportCaps: ["audit"],
  base: (ctx) => Prisma.sql`
    SELECT a.id, a.at, a.actor_id, a.actor_label, a.action, a.entity, a.entity_id, a.reason
    FROM audit_logs a
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND a.at >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND a.at < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.action", "b.entity", "b.entity_id", "b.actor_label", "b.reason"],
  dateColumn: { expr: "b.at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "entity", label: "Entity", expr: "b.entity", labelsSql: "SELECT DISTINCT entity AS value, replace(entity, '_', ' ') AS label FROM list_base_audit" },
    { key: "action", label: "Action", expr: "b.action" },
    {
      key: "actor", label: "Who", expr: ACTOR,
      labelsSql: "SELECT u.id AS value, u.name || ' (' || u.role::text || ')' AS label FROM users u WHERE u.id IN (SELECT actor_id FROM list_base_audit) UNION ALL SELECT 'system', 'System (scheduled jobs)' UNION ALL SELECT 'public', 'Public website'",
    },
    { key: "reason", label: "Reason given", expr: "CASE WHEN COALESCE(b.reason, '') <> '' THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "With a reason" }, { value: "no", label: "No reason" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.at DESC, b.id" },
    oldest: { label: "Oldest first", sql: "b.at ASC, b.id" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "LAST_7" }),
  summary: [
    { key: "today", label: "Today", sql: `count(*) FILTER (WHERE (b.at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY})`, format: "count", apply: { range: "TODAY" } },
    { key: "reason", label: "With a reason", sql: "count(*) FILTER (WHERE COALESCE(b.reason, '') <> '')", format: "count", apply: { reason: "yes" } },
    { key: "system", label: "By the system", sql: `count(*) FILTER (WHERE ${ACTOR} = 'system')`, format: "count", apply: { actor: "system" } },
  ],
  csv: [
    { key: "at", label: "When", format: "datetime" }, { key: "actor_label", label: "Who" }, { key: "action", label: "Action" },
    { key: "entity", label: "Entity" }, { key: "entity_id", label: "Entity id" }, { key: "reason", label: "Reason" },
  ],
};
