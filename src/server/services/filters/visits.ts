// v3 §3.2: check-ins (visits) — who came, for what (a court booking or social play), their tier on the day, who
// checked them in and whether they have checked out ("here now" = checked in today and not out yet).
import { Prisma } from "@prisma/client";
import { istDayRange } from "@/lib/time";
import type { ListDef } from "./core";

const VISIT_DAY = "(v.checked_in_at AT TIME ZONE 'Asia/Kolkata')::date";

export const visitsList: ListDef = {
  name: "visits",
  title: "Check-ins",
  view: ["checkin"],
  exportCaps: ["dashboard.ops"],
  // The date range is applied here too, so only the chosen days are read (visits grow without limit).
  base: (ctx) => Prisma.sql`
    SELECT v.id, v.checked_in_at, v.checked_out_at, v.member_id, v.guest_id, v.booking_id,
      COALESCE(m.name, g.name) AS name, COALESCE(m.phone, g.phone) AS phone, m.member_code,
      CASE WHEN v.member_id IS NOT NULL THEN 'member' ELSE 'guest' END AS who,
      CASE WHEN v.booking_id IS NOT NULL THEN 'BOOKING' WHEN so.id IS NOT NULL THEN 'SOCIAL' ELSE 'OTHER' END AS kind,
      CASE WHEN v.booking_id IS NOT NULL THEN bk.booking_code || ' · ' || c.name ELSE so.title END AS what,
      CASE WHEN v.member_id IS NULL THEN 'GUEST' ELSE COALESCE(ms.code, 'WALK_IN') END AS tier,
      v.by_user_id, u.name AS by_name,
      -- "Here now" only means today: older visits nobody checked out are shown as such, not as people still in.
      CASE WHEN v.checked_out_at IS NOT NULL THEN 'OUT' WHEN ${Prisma.raw(VISIT_DAY)} = ${ctx.today}::date THEN 'IN' ELSE 'NO_CHECKOUT' END AS state,
      ot.code AS open_tab_code
    FROM visits v
    LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN guests g ON g.id = v.guest_id
    LEFT JOIN bookings bk ON bk.id = v.booking_id
    LEFT JOIN court_reservations r ON r.id = bk.reservation_id
    LEFT JOIN courts c ON c.id = r.court_id
    LEFT JOIN users u ON u.id = v.by_user_id
    -- A social check-in writes the visit in the same transaction as the participant's check-in time.
    LEFT JOIN LATERAL (SELECT ss.id, ss.title FROM social_participants sp JOIN social_sessions ss ON ss.id = sp.session_id
                        WHERE v.booking_id IS NULL AND sp.checked_in_at = v.checked_in_at
                          AND (sp.member_id = v.member_id OR sp.guest_id = v.guest_id) LIMIT 1) so ON TRUE
    LEFT JOIN LATERAL (SELECT p.code::text AS code FROM memberships x JOIN plans p ON p.id = x.plan_id
                        WHERE x.member_id = v.member_id AND x.status IN ('ACTIVE', 'EXPIRED', 'CHANGED')
                          AND x.start_date <= ${Prisma.raw(VISIT_DAY)} AND x.end_date >= ${Prisma.raw(VISIT_DAY)}
                        ORDER BY x.end_date DESC LIMIT 1) ms ON TRUE
    LEFT JOIN LATERAL (SELECT t.code FROM tabs t WHERE v.member_id IS NOT NULL AND t.member_id = v.member_id AND t.status = 'OPEN' LIMIT 1) ot ON TRUE
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND v.checked_in_at >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND v.checked_in_at < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.name", "b.phone", "b.member_code", "b.what"],
  dateColumn: { expr: "b.checked_in_at", label: "Checked in", kind: "timestamp" },
  facets: [
    { key: "kind", label: "For", expr: "b.kind", options: [{ value: "BOOKING", label: "Court booking" }, { value: "SOCIAL", label: "Social play" }, { value: "OTHER", label: "Other" }] },
    { key: "who", label: "Member or guest", expr: "b.who", options: [{ value: "member", label: "Member" }, { value: "guest", label: "Guest" }] },
    { key: "tier", label: "Tier", expr: "b.tier", options: [
      { value: "GOLD", label: "Gold" }, { value: "SILVER", label: "Silver" }, { value: "JUNIOR", label: "Junior" },
      { value: "WALK_IN", label: "Member, no plan that day" }, { value: "GUEST", label: "Guest" },
    ] },
    { key: "by", label: "Checked in by", expr: "b.by_user_id", labelsSql: "SELECT id AS value, name AS label FROM users WHERE role <> 'MEMBER'" },
    { key: "state", label: "Checked out", expr: "b.state", options: [{ value: "IN", label: "Here now (in today, not out)" }, { value: "OUT", label: "Checked out" }, { value: "NO_CHECKOUT", label: "Earlier day, never checked out" }] },
  ],
  sorts: {
    newest: { label: "Latest first", sql: "b.checked_in_at DESC" },
    oldest: { label: "Earliest first", sql: "b.checked_in_at ASC" },
    name: { label: "Name", sql: "b.name ASC, b.checked_in_at DESC" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "TODAY" }),
  summary: [
    { key: "total", label: "Check-ins", sql: "count(*)", format: "count", apply: {} },
    { key: "members", label: "Members", sql: "count(*) FILTER (WHERE b.who = 'member')", format: "count", apply: { who: "member" } },
    { key: "guests", label: "Guests", sql: "count(*) FILTER (WHERE b.who = 'guest')", format: "count", apply: { who: "guest" } },
    { key: "in", label: "Members here now", sql: "count(*) FILTER (WHERE b.who = 'member' AND b.state = 'IN')", format: "count", apply: { who: "member", state: "IN" } },
  ],
  csv: [
    { key: "checked_in_at", label: "Checked in", format: "datetime" }, { key: "name", label: "Name" }, { key: "who", label: "Member/guest" },
    { key: "member_code", label: "Member code" }, { key: "tier", label: "Tier" }, { key: "kind", label: "For" }, { key: "what", label: "Booking / session" },
    { key: "by_name", label: "Checked in by" }, { key: "checked_out_at", label: "Checked out", format: "datetime" },
  ],
};
