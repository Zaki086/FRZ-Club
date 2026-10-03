// Members list (v3 §3.2, §6.2): status from membership dates and payment, dues, tabs, juniors, guardians, visits, sports.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const membersList: ListDef = {
  name: "members",
  title: "Members",
  view: ["members.view"],
  exportCaps: ["dashboard.ops", "dashboard.finance"],
  base: (ctx) => Prisma.sql`
    SELECT m.id, m.member_code AS code, m.name, m.phone, m.email, m.created_at AS joined_at,
      COALESCE(cur.code::text, 'WALK_IN') AS tier,
      CASE WHEN pend.id IS NOT NULL THEN 'PENDING_PAYMENT'
           WHEN cur.id IS NOT NULL AND cur.end_date <= ${ctx.today}::date + 7 THEN 'EXPIRING'
           WHEN cur.id IS NOT NULL THEN 'ACTIVE'
           WHEN sched.id IS NOT NULL THEN 'SCHEDULED'
           WHEN past.n > 0 THEN 'EXPIRED'
           ELSE 'NONE' END AS status,
      cur.end_date AS ends_on,
      COALESCE(d.due, 0)::int AS dues,
      (t.id IS NOT NULL) AS open_tab,
      (cur.code::text = 'JUNIOR' OR m.dob > ${ctx.today}::date - interval '18 years') AS junior,
      (m.guardian_name IS NOT NULL) AS has_guardian,
      v.last_visit,
      COALESCE(sp.sports, '{}'::text[]) AS sports
    FROM members m
    LEFT JOIN LATERAL (SELECT ms.id, ms.end_date, p.code FROM memberships ms JOIN plans p ON p.id = ms.plan_id
                        WHERE ms.member_id = m.id AND ms.status = 'ACTIVE' AND ms.start_date <= ${ctx.today}::date AND ms.end_date >= ${ctx.today}::date
                        ORDER BY ms.end_date DESC LIMIT 1) cur ON TRUE
    LEFT JOIN LATERAL (SELECT id FROM memberships WHERE member_id = m.id AND status = 'PENDING_PAYMENT' LIMIT 1) pend ON TRUE
    LEFT JOIN LATERAL (SELECT id FROM memberships WHERE member_id = m.id AND status = 'SCHEDULED' LIMIT 1) sched ON TRUE
    LEFT JOIN LATERAL (SELECT count(*) AS n FROM memberships WHERE member_id = m.id AND status IN ('ACTIVE', 'EXPIRED', 'CHANGED', 'CANCELLED')) past ON TRUE
    LEFT JOIN LATERAL (SELECT sum(b.total - (b.amount_paid - b.amount_refunded)) AS due FROM bills b
                        WHERE b.member_id = m.id AND b.closed_at IS NULL AND b.total > b.amount_paid - b.amount_refunded) d ON TRUE
    LEFT JOIN LATERAL (SELECT id FROM tabs WHERE member_id = m.id AND status IN ('OPEN', 'CARRIED') LIMIT 1) t ON TRUE
    LEFT JOIN LATERAL (SELECT max(checked_in_at) AS last_visit FROM visits WHERE member_id = m.id) v ON TRUE
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT c.sport::text) AS sports FROM booking_players bp
                        JOIN bookings bk ON bk.id = bp.booking_id JOIN court_reservations r ON r.id = bk.reservation_id JOIN courts c ON c.id = r.court_id
                        WHERE bp.member_id = m.id AND bp.removed_at IS NULL) sp ON TRUE
    WHERE m.anonymised_at IS NULL`,
  search: ["b.name", "b.phone", "b.code", "b.email"],
  dateColumn: { expr: "b.joined_at", label: "Joined", kind: "timestamp" },
  facets: [
    { key: "tier", label: "Tier", expr: "b.tier", options: [{ value: "GOLD", label: "Gold" }, { value: "SILVER", label: "Silver" }, { value: "JUNIOR", label: "Junior" }, { value: "WALK_IN", label: "No current plan" }] },
    {
      key: "status", label: "Membership", expr: "b.status",
      options: [{ value: "ACTIVE", label: "Active" }, { value: "EXPIRING", label: "Expiring ≤ 7 days" }, { value: "EXPIRED", label: "Expired" }, { value: "PENDING_PAYMENT", label: "Pending payment" }, { value: "SCHEDULED", label: "Scheduled" }, { value: "NONE", label: "Never had a plan" }],
    },
    { key: "dues", label: "Dues", expr: "CASE WHEN b.dues > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has dues" }, { value: "no", label: "Nothing due" }] },
    { key: "tab", label: "Bar tab", expr: "CASE WHEN b.open_tab THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Open tab" }, { value: "no", label: "No open tab" }] },
    { key: "junior", label: "Junior", expr: "CASE WHEN b.junior THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Junior / under 18" }, { value: "no", label: "Adult" }] },
    { key: "guardian", label: "Guardian", expr: "CASE WHEN b.has_guardian THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has guardian" }, { value: "no", label: "No guardian" }] },
    {
      key: "visit", label: "Last visit",
      expr: "CASE WHEN b.last_visit IS NULL THEN 'never' WHEN b.last_visit >= app_now() - interval '7 days' THEN 'le7' WHEN b.last_visit >= app_now() - interval '30 days' THEN 'd8_30' ELSE 'gt30' END",
      options: [{ value: "le7", label: "≤ 7 days" }, { value: "d8_30", label: "8–30 days" }, { value: "gt30", label: "> 30 days" }, { value: "never", label: "Never" }],
    },
    { key: "sport", label: "Sport played", expr: "b.sports", multi: true, options: [{ value: "TENNIS", label: "Tennis" }, { value: "CRICKET", label: "Cricket" }, { value: "PADEL", label: "Padel" }, { value: "BADMINTON", label: "Badminton" }] },
  ],
  sorts: {
    name: { label: "Name", sql: "b.name ASC, b.code ASC" },
    joined: { label: "Newest first", sql: "b.joined_at DESC, b.code DESC" },
    dues: { label: "Most due", sql: "b.dues DESC, b.name ASC" },
    ends: { label: "Ending soonest", sql: "b.ends_on ASC NULLS LAST, b.name ASC" },
    visit: { label: "Last visit", sql: "b.last_visit DESC NULLS LAST, b.name ASC" },
  },
  defaultSort: "name",
  summary: [
    { key: "active", label: "Active", sql: "count(*) FILTER (WHERE b.status IN ('ACTIVE', 'EXPIRING'))", format: "count", apply: { status: "ACTIVE,EXPIRING" } },
    { key: "expiring", label: "Expiring this week", sql: "count(*) FILTER (WHERE b.status = 'EXPIRING')", format: "count", apply: { status: "EXPIRING" } },
    { key: "dues", label: "With dues", sql: "COALESCE(sum(b.dues) FILTER (WHERE b.dues > 0), 0)", format: "money", apply: { dues: "yes" } },
    { key: "new", label: "New this month", sql: "count(*) FILTER (WHERE b.joined_at >= date_trunc('month', app_now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')", format: "count", apply: { range: "THIS_MONTH" } },
  ],
  csv: [
    { key: "code", label: "Member code" }, { key: "name", label: "Name" }, { key: "phone", label: "Mobile" }, { key: "email", label: "Email" },
    { key: "tier", label: "Tier" }, { key: "status", label: "Membership" }, { key: "ends_on", label: "Ends", format: "date" }, { key: "dues", label: "Dues (₹)", format: "money" },
    { key: "last_visit", label: "Last visit", format: "datetime" }, { key: "joined_at", label: "Joined", format: "date" },
  ],
};
