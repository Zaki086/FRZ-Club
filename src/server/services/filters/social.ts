// v3 §3.2: social play sessions — status, courts and sports, places left, fees still to collect — with the players
// who have joined each one (for the board view and its actions).
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const SPORTS = [{ value: "TENNIS", label: "Tennis" }, { value: "CRICKET", label: "Cricket" }, { value: "PADEL", label: "Padel" }, { value: "BADMINTON", label: "Badminton" }];
const DUE = "CASE WHEN bl.id IS NULL OR bl.closed_at IS NOT NULL THEN 0 ELSE GREATEST(0, bl.total - (bl.amount_paid - bl.amount_refunded)) END";

export const socialList: ListDef = {
  name: "social",
  title: "Social play",
  view: ["courts.view"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT s.id, s.title, s.series_id, s.start_at, s.end_at, s.status::text AS status,
      s.capacity_per_court * COALESCE(c.n, 0) AS capacity,
      COALESCE(p.joined, 0) AS joined,
      GREATEST(0, s.capacity_per_court * COALESCE(c.n, 0) - COALESCE(p.joined, 0)) AS free,
      c.courts, COALESCE(c.court_ids, '{}'::text[]) AS court_ids, COALESCE(c.sports, '{}'::text[]) AS sports,
      COALESCE(p.checked_in, 0) AS checked_in, COALESCE(p.due, 0) AS due, COALESCE(p.fees, 0) AS fees, p.names,
      COALESCE(p.list, '[]'::jsonb) AS participants
    FROM social_sessions s
    LEFT JOIN LATERAL (SELECT count(*)::int AS n, string_agg(co.name, ', ' ORDER BY co.sort_order, co.name) AS courts,
                              array_agg(co.id) AS court_ids, array_agg(DISTINCT co.sport::text) AS sports
                         FROM social_session_courts sc JOIN courts co ON co.id = sc.court_id WHERE sc.session_id = s.id) c ON TRUE
    LEFT JOIN LATERAL (SELECT count(*)::int AS joined, count(*) FILTER (WHERE sp.checked_in_at IS NOT NULL)::int AS checked_in,
                              sum(${Prisma.raw(DUE)})::int AS due, sum(sp.fee_snapshot)::int AS fees,
                              string_agg(COALESCE(m.name, g.name), ', ' ORDER BY sp.created_at) AS names,
                              jsonb_agg(jsonb_build_object('id', sp.id, 'name', COALESCE(m.name, g.name), 'memberId', sp.member_id, 'tier', sp.tier_snapshot,
                                                           'fee', sp.fee_snapshot, 'checkedInAt', sp.checked_in_at, 'billId', sp.bill_id) ORDER BY sp.created_at) AS list
                         FROM social_participants sp
                         LEFT JOIN members m ON m.id = sp.member_id
                         LEFT JOIN guests g ON g.id = sp.guest_id
                         LEFT JOIN bills bl ON bl.id = sp.bill_id
                        WHERE sp.session_id = s.id AND sp.status = 'JOINED') p ON TRUE`,
  search: ["b.title", "b.courts", "b.names"],
  dateColumn: { expr: "b.start_at", label: "Starts", kind: "timestamp" },
  facets: [
    { key: "when", label: "When", expr: "CASE WHEN b.end_at > app_now() THEN 'upcoming' ELSE 'past' END", options: [{ value: "upcoming", label: "Upcoming or on now" }, { value: "past", label: "Finished" }] },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "SCHEDULED", label: "Scheduled" }, { value: "COMPLETED", label: "Completed" }, { value: "CANCELLED", label: "Cancelled" }] },
    { key: "court", label: "Court", expr: "b.court_ids", multi: true, labelsSql: "SELECT id AS value, name AS label FROM courts" },
    { key: "sport", label: "Sport", expr: "b.sports", multi: true, options: SPORTS },
    { key: "places", label: "Places", expr: "CASE WHEN b.status = 'SCHEDULED' AND b.free > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has free places" }, { value: "no", label: "Full or not taking players" }] },
    { key: "unpaid", label: "Fees", expr: "CASE WHEN b.due > 0 THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Fees to collect" }, { value: "no", label: "All paid" }] },
  ],
  sorts: {
    soonest: { label: "Soonest first", sql: "b.start_at ASC" },
    latest: { label: "Latest first", sql: "b.start_at DESC" },
    fullest: { label: "Fullest first", sql: "b.joined::float / GREATEST(b.capacity, 1) DESC, b.start_at ASC" },
  },
  defaultSort: "soonest",
  // The board used to show sessions from today onwards; "upcoming" keeps that view on first open.
  defaults: () => ({ when: "upcoming" }),
  summary: [
    { key: "scheduled", label: "Scheduled sessions", sql: "count(*) FILTER (WHERE b.status = 'SCHEDULED')", format: "count", apply: { status: "SCHEDULED" } },
    { key: "joined", label: "Players joined", sql: "COALESCE(sum(b.joined), 0)", format: "count", apply: {} },
    { key: "free", label: "Free places", sql: "COALESCE(sum(b.free) FILTER (WHERE b.status = 'SCHEDULED'), 0)", format: "count", apply: { places: "yes" } },
    { key: "due", label: "Fees to collect", sql: "COALESCE(sum(b.due), 0)", format: "money", apply: { unpaid: "yes" } },
  ],
  csv: [
    { key: "title", label: "Session" }, { key: "start_at", label: "Starts", format: "datetime" }, { key: "end_at", label: "Ends", format: "datetime" },
    { key: "courts", label: "Courts" }, { key: "status", label: "Status" }, { key: "joined", label: "Joined" }, { key: "capacity", label: "Capacity" },
    { key: "checked_in", label: "Checked in" }, { key: "fees", label: "Fees (₹)", format: "money" }, { key: "due", label: "To collect (₹)", format: "money" },
  ],
};
