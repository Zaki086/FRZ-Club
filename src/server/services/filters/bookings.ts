// Bookings list (v3 §3.2, §7.1).
import { Prisma } from "@prisma/client";
import { istDayRange } from "@/lib/time";
import type { ListDef } from "./core";

export const bookingsList: ListDef = {
  name: "bookings",
  title: "Bookings",
  view: ["courts.view"],
  exportCaps: ["dashboard.ops"],
  // The date range is applied here too, so only the chosen days are read (bookings grow without limit).
  base: (ctx) => Prisma.sql`
    SELECT bk.id, bk.booking_code AS code, r.start_at, r.end_at, c.id AS court_id, c.name AS court, c.sport::text AS sport,
      bk.status::text AS status, bk.channel::text AS channel,
      COALESCE(bl.total, 0) AS total,
      CASE WHEN bl.id IS NULL OR bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END AS due,
      CASE WHEN COALESCE(bl.total, 0) = 0 THEN 'FREE'
           WHEN bl.closed_at IS NOT NULL OR bl.total <= bl.amount_paid - bl.amount_refunded THEN 'PAID'
           WHEN bl.amount_paid > 0 THEN 'PARTIAL' ELSE 'UNPAID' END AS payment,
      CASE WHEN bk.primary_member_id IS NOT NULL THEN 'member' ELSE 'guest' END AS who,
      bk.created_by, bk.cancelled_by, bk.cancel_reason,
      pl.players, pl.checked_in, pl.n_players,
      cc.id AS resolution_id, cc.status AS resolution, cc.amount_paid AS resolution_paid, cc.deadline_at AS resolution_deadline
    FROM bookings bk
    LEFT JOIN club_cancellations cc ON cc.booking_id = bk.id
    JOIN court_reservations r ON r.id = bk.reservation_id
    JOIN courts c ON c.id = r.court_id
    LEFT JOIN bills bl ON bl.id = bk.bill_id
    LEFT JOIN LATERAL (SELECT string_agg(COALESCE(m.name, g.name), ', ' ORDER BY bp.created_at) AS players,
                              count(*) FILTER (WHERE bp.checked_in_at IS NOT NULL) AS checked_in, count(*) AS n_players
                         FROM booking_players bp LEFT JOIN members m ON m.id = bp.member_id LEFT JOIN guests g ON g.id = bp.guest_id
                        WHERE bp.booking_id = bk.id AND bp.removed_at IS NULL) pl ON TRUE
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND r.start_at >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND r.start_at < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.code", "b.players", "b.court"],
  dateColumn: { expr: "b.start_at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "court", label: "Court", expr: "b.court_id", labelsSql: "SELECT id AS value, name AS label FROM courts" },
    { key: "sport", label: "Sport", expr: "b.sport", options: [{ value: "TENNIS", label: "Tennis" }, { value: "CRICKET", label: "Cricket" }, { value: "PADEL", label: "Padel" }, { value: "BADMINTON", label: "Badminton" }] },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "CONFIRMED", label: "Confirmed" }, { value: "COMPLETED", label: "Completed" }, { value: "NO_SHOW", label: "No-show" }, { value: "CANCELLED", label: "Cancelled" }, { value: "CANCELLED_BY_CLUB", label: "Cancelled by club" }] },
    { key: "channel", label: "Channel", expr: "b.channel", options: [{ value: "FRONT_DESK", label: "Front desk" }, { value: "PHONE", label: "Phone" }, { value: "MESSAGE", label: "Message" }, { value: "WALK_IN", label: "Walk-in" }, { value: "ONLINE_MEMBER", label: "Member portal" }, { value: "ONLINE_TRIAL", label: "Trial" }] },
    { key: "payment", label: "Payment", expr: "b.payment", options: [{ value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Part-paid" }, { value: "PAID", label: "Paid" }, { value: "FREE", label: "Nothing to pay" }] },
    { key: "resolution", label: "Club cancellation", expr: "COALESCE(b.resolution, CASE WHEN b.status = 'CANCELLED_BY_CLUB' THEN 'NOTHING_OWED' ELSE 'none' END)", options: [
      { value: "PENDING_CHOICE", label: "Pending choice" }, { value: "RESCHEDULED", label: "Rescheduled" }, { value: "REFUNDED", label: "Refunded" },
      { value: "NOTHING_OWED", label: "Unpaid — nothing owed" }, { value: "none", label: "Not cancelled by the club" },
    ] },
    { key: "who", label: "Booked for", expr: "b.who", options: [{ value: "member", label: "Member" }, { value: "guest", label: "Guest" }] },
    { key: "by", label: "Created by", expr: "COALESCE(b.created_by, 'online')", labelsSql: "SELECT id AS value, name AS label FROM users UNION ALL SELECT 'online', 'Online / system'" },
  ],
  sorts: {
    time: { label: "Start time", sql: "b.start_at ASC, b.court ASC" },
    latest: { label: "Latest first", sql: "b.start_at DESC, b.court ASC" },
    due: { label: "Most due", sql: "b.due DESC, b.start_at ASC" },
  },
  defaultSort: "time",
  defaults: () => ({ range: "TODAY" }),
  summary: [
    { key: "bookings", label: "Bookings", sql: "count(*) FILTER (WHERE b.status NOT IN ('CANCELLED', 'CANCELLED_BY_CLUB'))", format: "count", apply: { status: "CONFIRMED,COMPLETED,NO_SHOW" } },
    { key: "due", label: "To collect", sql: "COALESCE(sum(b.due) FILTER (WHERE b.status = 'CONFIRMED'), 0)", format: "money", apply: { payment: "UNPAID,PARTIAL", status: "CONFIRMED" } },
    { key: "noshow", label: "No-shows", sql: "count(*) FILTER (WHERE b.status = 'NO_SHOW')", format: "count", apply: { status: "NO_SHOW" } },
    { key: "cancelled", label: "Cancelled", sql: "count(*) FILTER (WHERE b.status IN ('CANCELLED', 'CANCELLED_BY_CLUB'))", format: "count", apply: { status: "CANCELLED,CANCELLED_BY_CLUB" } },
  ],
  csv: [
    { key: "code", label: "Booking" }, { key: "start_at", label: "Start", format: "datetime" }, { key: "court", label: "Court" }, { key: "sport", label: "Sport" },
    { key: "players", label: "Players" }, { key: "status", label: "Status" }, { key: "channel", label: "Channel" }, { key: "payment", label: "Payment" },
    { key: "total", label: "Total (₹)", format: "money" }, { key: "due", label: "Due (₹)", format: "money" },
  ],
};
