// v3 §3.2: everyone who joined a social play session — joined, left or cancelled by the club — with the fee,
// whether it is paid and whether they checked in.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const socialParticipantsList: ListDef = {
  name: "social-participants",
  title: "Social players",
  view: ["courts.view"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT sp.id, sp.session_id, s.title, s.start_at, s.end_at, s.status::text AS session_status, sp.status::text AS status,
      sp.member_id, sp.guest_id, COALESCE(m.name, g.name) AS name, COALESCE(m.phone, g.phone) AS phone, m.member_code,
      CASE WHEN sp.member_id IS NOT NULL THEN 'member' ELSE 'guest' END AS who,
      sp.tier_snapshot AS tier, sp.fee_snapshot AS fee, sp.bill_id, sp.channel::text AS channel,
      sp.checked_in_at, sp.left_at, sp.created_at AS joined_at,
      CASE WHEN bl.id IS NULL THEN 0 ELSE bl.amount_paid - bl.amount_refunded END AS paid,
      CASE WHEN bl.id IS NULL OR bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END AS due,
      CASE WHEN COALESCE(bl.total, 0) = 0 THEN 'FREE'
           WHEN bl.closed_at IS NOT NULL THEN 'CLOSED'
           WHEN bl.total <= bl.amount_paid - bl.amount_refunded THEN 'PAID'
           WHEN bl.amount_paid > 0 THEN 'PARTIAL' ELSE 'UNPAID' END AS payment
    FROM social_participants sp
    JOIN social_sessions s ON s.id = sp.session_id
    LEFT JOIN members m ON m.id = sp.member_id
    LEFT JOIN guests g ON g.id = sp.guest_id
    LEFT JOIN bills bl ON bl.id = sp.bill_id`,
  search: ["b.name", "b.phone", "b.member_code", "b.title"],
  dateColumn: { expr: "b.start_at", label: "Session", kind: "timestamp" },
  facets: [
    { key: "when", label: "When", expr: "CASE WHEN b.end_at > app_now() THEN 'upcoming' ELSE 'past' END", options: [{ value: "upcoming", label: "Upcoming or on now" }, { value: "past", label: "Finished" }] },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "JOINED", label: "Joined" }, { value: "LEFT", label: "Left" }, { value: "CANCELLED_BY_CLUB", label: "Cancelled by club" }] },
    { key: "who", label: "Member or guest", expr: "b.who", options: [{ value: "member", label: "Member" }, { value: "guest", label: "Guest" }] },
    { key: "payment", label: "Payment", expr: "b.payment", options: [
      { value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Part-paid" }, { value: "PAID", label: "Paid" },
      { value: "FREE", label: "Nothing to pay" }, { value: "CLOSED", label: "Bill closed (left or cancelled)" },
    ] },
    { key: "checkin", label: "Check-in", expr: "CASE WHEN b.checked_in_at IS NOT NULL THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Checked in" }, { value: "no", label: "Not checked in" }] },
    { key: "session", label: "Session", expr: "b.session_id", labelsSql: "SELECT id AS value, title || ' · ' || to_char(start_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS label FROM social_sessions" },
  ],
  sorts: {
    soonest: { label: "Soonest session first", sql: "b.start_at ASC, b.joined_at ASC" },
    latest: { label: "Latest session first", sql: "b.start_at DESC, b.joined_at ASC" },
    due: { label: "Most due", sql: "b.due DESC, b.start_at ASC" },
    name: { label: "Name", sql: "b.name ASC, b.start_at ASC" },
  },
  defaultSort: "soonest",
  defaults: () => ({ when: "upcoming" }),
  summary: [
    { key: "joined", label: "Joined", sql: "count(*) FILTER (WHERE b.status = 'JOINED')", format: "count", apply: { status: "JOINED" } },
    { key: "due", label: "Fees to collect", sql: "COALESCE(sum(b.due) FILTER (WHERE b.status = 'JOINED'), 0)", format: "money", apply: { status: "JOINED", payment: "UNPAID,PARTIAL" } },
    { key: "checked_in", label: "Checked in", sql: "count(*) FILTER (WHERE b.checked_in_at IS NOT NULL)", format: "count", apply: { checkin: "yes" } },
    { key: "by_club", label: "Cancelled by club", sql: "count(*) FILTER (WHERE b.status = 'CANCELLED_BY_CLUB')", format: "count", apply: { status: "CANCELLED_BY_CLUB" } },
  ],
  csv: [
    { key: "name", label: "Player" }, { key: "who", label: "Member/guest" }, { key: "member_code", label: "Member code" }, { key: "tier", label: "Tier" },
    { key: "title", label: "Session" }, { key: "start_at", label: "Starts", format: "datetime" }, { key: "status", label: "Status" },
    { key: "fee", label: "Fee (₹)", format: "money" }, { key: "paid", label: "Paid (₹)", format: "money" }, { key: "due", label: "Due (₹)", format: "money" },
    { key: "payment", label: "Payment" }, { key: "checked_in_at", label: "Checked in", format: "datetime" }, { key: "channel", label: "Channel" },
  ],
};
