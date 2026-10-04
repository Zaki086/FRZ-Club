// Leads list and board (v3 §3.2, §8.1).
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const leadsList: ListDef = {
  name: "leads",
  title: "Leads",
  view: ["crm"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT l.id, l.code, l.name, l.phone, l.email, l.status::text AS status, l.source::text AS source, l.interest,
      l.assigned_to, u.name AS assignee, l.next_follow_up_at, l.created_at, l.lost_reason,
      (l.status IN ('NEW', 'CONTACTED', 'QUOTED') AND l.next_follow_up_at < app_now()) AS overdue,
      -- v6 §3: the board opens the quote builder for a lead with no quote; "Converting…" while a member made from
      -- this lead ("Convert to member") has not paid yet (the lead turns WON on payment, CR-7).
      EXISTS (SELECT 1 FROM quotes q WHERE q.lead_id = l.id) AS has_quote,
      (l.status IN ('NEW', 'CONTACTED', 'QUOTED') AND EXISTS (SELECT 1 FROM members m WHERE m.lead_id = l.id)) AS converting
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to`,
  search: ["b.name", "b.phone", "b.code", "b.email"],
  dateColumn: { expr: "b.created_at", label: "Created", kind: "timestamp" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "NEW", label: "New" }, { value: "CONTACTED", label: "Contacted" }, { value: "QUOTED", label: "Quoted" }, { value: "WON", label: "Won" }, { value: "LOST", label: "Lost" }] },
    { key: "source", label: "Source", expr: "b.source", options: [{ value: "WEBSITE_ENQUIRY", label: "Website" }, { value: "TRIAL_BOOKING", label: "Trial" }, { value: "WALK_IN", label: "Walk-in" }, { value: "PHONE", label: "Phone" }, { value: "REFERRAL", label: "Referral" }] },
    { key: "assignee", label: "Assignee", expr: "COALESCE(b.assigned_to, 'none')", meAlias: true, labelsSql: "SELECT id AS value, name AS label FROM users UNION ALL SELECT 'none', 'Unassigned'" },
    { key: "overdue", label: "Follow-up", expr: "CASE WHEN b.overdue THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Overdue" }, { value: "no", label: "On time" }] },
    { key: "interest", label: "Interest", expr: "NULLIF(b.interest, '')" },
  ],
  sorts: {
    followup: { label: "Follow-up due", sql: "b.next_follow_up_at ASC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    name: { label: "Name", sql: "b.name ASC" },
  },
  defaultSort: "followup",
  // Front desk opens on their own open leads; others on every open lead.
  defaults: (actor): Record<string, string> =>
    actor.kind === "USER" && actor.role === "FRONT_DESK" ? { status: "NEW,CONTACTED,QUOTED", assignee: "me" } : { status: "NEW,CONTACTED,QUOTED" },
  summary: [
    { key: "open", label: "Open", sql: "count(*) FILTER (WHERE b.status IN ('NEW', 'CONTACTED', 'QUOTED'))", format: "count", apply: { status: "NEW,CONTACTED,QUOTED" } },
    { key: "overdue", label: "Overdue follow-ups", sql: "count(*) FILTER (WHERE b.overdue)", format: "count", apply: { overdue: "yes" } },
    { key: "unassigned", label: "Unassigned", sql: "count(*) FILTER (WHERE b.assigned_to IS NULL AND b.status IN ('NEW', 'CONTACTED', 'QUOTED'))", format: "count", apply: { assignee: "none" } },
    { key: "won", label: "Won this month", sql: "count(*) FILTER (WHERE b.status = 'WON' AND b.created_at >= date_trunc('month', app_now()))", format: "count", apply: { status: "WON", range: "THIS_MONTH" } },
  ],
  csv: [
    { key: "code", label: "Lead" }, { key: "name", label: "Name" }, { key: "phone", label: "Mobile" }, { key: "email", label: "Email" }, { key: "status", label: "Status" },
    { key: "source", label: "Source" }, { key: "interest", label: "Interest" }, { key: "assignee", label: "Assignee" }, { key: "next_follow_up_at", label: "Follow up", format: "datetime" }, { key: "created_at", label: "Created", format: "date" },
  ],
};
