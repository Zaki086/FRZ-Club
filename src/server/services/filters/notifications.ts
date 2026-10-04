// v3 §6.3/§6.5: the notification log (every attempt per channel) — also the front desk's "Messages to send" queue —
// and the Renewals & dues screen (NT-3).
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";
import { membersList } from "./members";
import { WA_TEMPLATE_OPTIONS } from "./messages";

const CHANNEL_OPTIONS = [
  { value: "IN_APP", label: "In-app" }, { value: "PUSH", label: "Push" }, { value: "EMAIL", label: "Email" },
  { value: "WHATSAPP_API", label: "WhatsApp (automatic)" }, { value: "WHATSAPP_MANUAL", label: "WhatsApp (by hand)" },
];
const STATUS_OPTIONS = [
  { value: "QUEUED", label: "To send" }, { value: "LINK_OPENED", label: "WhatsApp opened" }, { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" }, { value: "FAILED", label: "Failed" }, { value: "SKIPPED", label: "Not available" },
];
const EVENT_OPTIONS = [
  { value: "MEMBERSHIP_WELCOME", label: "Welcome + login link" }, { value: "MEMBERSHIP_RENEWED", label: "Membership confirmed" },
  { value: "MEMBERSHIP_EXPIRY", label: "Expiry reminder" }, { value: "DUES_REMINDER", label: "Dues reminder" },
  { value: "REFUND_COMPLETED", label: "Refund paid" }, { value: "CREDENTIALS_REISSUED", label: "New login link" },
  { value: "BOOKING_CANCELLED_BY_CLUB", label: "Cancelled by the club" }, { value: "BOOKING_CANCELLED", label: "Booking cancelled" },
  { value: "BOOKING_RESCHEDULED", label: "Booking moved" }, { value: "BOOKING_AUTO_REFUNDED", label: "Refunded automatically" },
  { value: "REFUND_REQUESTED", label: "Refund asked for" }, { value: "REFUND_APPROVED", label: "Refund approved" }, { value: "REFUND_REJECTED", label: "Refund not approved" },
  // v4 §4.1 catalogue
  { value: "REFUND_READY_TO_COLLECT", label: "Refund ready to collect" }, { value: "REFUND_COLLECTED", label: "Refund collected" },
  { value: "REFUND_UNCLAIMED_REMINDER", label: "Refund waiting (reminder)" }, { value: "BOOKING_CONFIRMED", label: "Booking confirmed" },
  { value: "BOOKING_PLAYER_ADDED", label: "Added to a booking" }, { value: "SESSION_REMINDER", label: "Session reminder (2 h)" },
  { value: "SOCIAL_SESSION_REMINDER", label: "Social play reminder (2 h)" }, { value: "CANCELLATION_CHOICE_REMINDER", label: "Reschedule or refund? (reminder)" },
  { value: "ORDER_READY", label: "Order ready to collect" }, { value: "RESTRING_READY", label: "Racket ready" },
  { value: "LEAD_ASSIGNED", label: "Staff: lead assigned" }, { value: "LEAD_ESCALATED", label: "Staff: lead escalated" },
  { value: "REFUND_APPROVAL_NEEDED", label: "Staff: refund to approve" }, { value: "DRAWER_VARIANCE", label: "Staff: drawer variance" },
  { value: "LEAVE_DECIDED", label: "Staff: leave decided" },
  // v4 §5.4 step 6: an inbound WhatsApp message (other than STOP) waiting for the front desk to answer.
  { value: "WHATSAPP_REPLY", label: "Member replied on WhatsApp" },
  // v5 §3.3 MT-6 (MSGCORE): a message sent by staff from a template (composer or bulk).
  { value: "TEMPLATE_MESSAGE", label: "Message from a template" },
];

export const notificationsList: ListDef = {
  name: "notifications",
  title: "Notifications",
  view: ["notifications.log"],
  exportCaps: ["dashboard.ops"],
  base: () => Prisma.sql`
    SELECT d.id, d.event, d.channel, d.status, d.created_at, d.sent_at, d.delivered_at, d.opened_at, d.title, d.body, d.error,
      -- v4 §5.4: automatic WhatsApp recipients are shown masked; the desk needs the full number only for manual ones.
      CASE WHEN d.template_id IS NOT NULL THEN COALESCE(d.to_masked, d.to_address)
           WHEN d.channel = 'WHATSAPP_API' AND d.to_address IS NOT NULL THEN '+91 ••••••' || right(d.to_address, 4) ELSE d.to_address END AS to_address,
      d.wa_template, d.attempts, d.urgent, d.wa_status, d.wa_read_at,
      CASE WHEN d.status = 'QUEUED' THEN d.not_before END AS next_try_at,
      CASE WHEN d.status = 'FAILED' THEN COALESCE(d.wa_failed_at, d.updated_at) END AS failed_at,
      d.member_id, m.name AS member_name, m.member_code, COALESCE(u.name, gu.name || ' (guest)', ld.name || ' (lead)') AS recipient, d.user_id,
      CASE WHEN d.triggered_by IS NULL OR d.triggered_by = 'system' THEN 'system' ELSE 'staff' END AS trigger,
      tu.name AS triggered_by_name, hu.name AS handled_by_name,
      -- v5 MT-6: the template and version a message was sent from, and its bulk send.
      d.template_id, mt.name AS template_name, d.template_version, d.bulk_id
    FROM notification_deliveries d
    LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN guests gu ON gu.id = d.guest_id
    LEFT JOIN members m ON m.id = d.member_id
    LEFT JOIN users tu ON tu.id = d.triggered_by
    LEFT JOIN users hu ON hu.id = d.handled_by
    LEFT JOIN message_templates mt ON mt.id = d.template_id
    LEFT JOIN leads ld ON ld.id = d.lead_id`,
  search: ["b.recipient", "b.member_name", "b.member_code", "b.to_address", "b.title", "b.template_name"],
  dateColumn: { expr: "b.created_at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "type", label: "Type", expr: "b.event", options: EVENT_OPTIONS },
    { key: "channel", label: "Channel", expr: "b.channel", options: CHANNEL_OPTIONS },
    { key: "status", label: "Status", expr: "b.status", options: STATUS_OPTIONS },
    { key: "template", label: "WhatsApp template", expr: "b.wa_template", options: WA_TEMPLATE_OPTIONS },
    { key: "member", label: "Member", expr: "b.member_id", labelsSql: "SELECT id AS value, name || ' · ' || member_code AS label FROM members" },
    { key: "trigger", label: "Triggered by", expr: "b.trigger", options: [{ value: "system", label: "System" }, { value: "staff", label: "Staff" }] },
    { key: "message_template", label: "Message template", expr: "b.template_id", labelsSql: "SELECT id AS value, name AS label FROM message_templates" },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.created_at DESC, b.channel" },
    oldest: { label: "Oldest first", sql: "b.created_at ASC, b.channel" },
  },
  defaultSort: "newest",
  summary: [
    { key: "tosend", label: "WhatsApp to send by hand", sql: "count(*) FILTER (WHERE b.channel = 'WHATSAPP_MANUAL' AND b.status IN ('QUEUED', 'LINK_OPENED'))", format: "count", apply: { channel: "WHATSAPP_MANUAL", status: "QUEUED,LINK_OPENED" } },
    { key: "sent", label: "Sent or delivered", sql: "count(*) FILTER (WHERE b.status IN ('SENT', 'DELIVERED') AND b.channel <> 'IN_APP')", format: "count", apply: { status: "SENT,DELIVERED" } },
    { key: "failed", label: "Failed", sql: "count(*) FILTER (WHERE b.status = 'FAILED')", format: "count", apply: { status: "FAILED" } },
    { key: "skipped", label: "Channel not available", sql: "count(*) FILTER (WHERE b.status = 'SKIPPED')", format: "count", apply: { status: "SKIPPED" } },
  ],
  csv: [
    { key: "created_at", label: "When", format: "datetime" }, { key: "event", label: "Type" }, { key: "channel", label: "Channel" }, { key: "status", label: "Status" },
    { key: "recipient", label: "Recipient" }, { key: "member_code", label: "Member code" }, { key: "to_address", label: "To" }, { key: "title", label: "Title" },
    { key: "error", label: "Reason / error" }, { key: "trigger", label: "Triggered by" }, { key: "handled_by_name", label: "Sent by hand by" },
    { key: "wa_template", label: "WhatsApp template" }, { key: "template_name", label: "Message template" }, { key: "template_version", label: "Template version" }, { key: "attempts", label: "Tries" }, { key: "sent_at", label: "Sent", format: "datetime" },
    { key: "delivered_at", label: "Delivered", format: "datetime" }, { key: "wa_read_at", label: "Read", format: "datetime" }, { key: "failed_at", label: "Failed", format: "datetime" },
  ],
  defaults: () => ({ range: "LAST_7" }),
};

/** NT-3: members to renew (expiring soon or recently expired) or with dues, with who was told, how and when. */
export const renewalsList: ListDef = {
  name: "renewals",
  title: "Renewals & dues",
  view: ["members.view"],
  exportCaps: ["dashboard.ops"],
  base: (ctx) => Prisma.sql`
    SELECT x.*, le.last_end, lc.last_contact_at, lc.last_event, hw.how, mw.manual_id
    FROM (${membersList.base(ctx)}) x
    LEFT JOIN LATERAL (SELECT max(end_date) AS last_end FROM memberships WHERE member_id = x.id AND status IN ('ACTIVE', 'EXPIRED')) le ON TRUE
    LEFT JOIN LATERAL (SELECT d.created_at AS last_contact_at, d.event AS last_event, d.dedupe_key FROM notification_deliveries d
                        WHERE d.member_id = x.id AND d.event IN ('MEMBERSHIP_EXPIRY', 'DUES_REMINDER') ORDER BY d.created_at DESC LIMIT 1) lc ON TRUE
    LEFT JOIN LATERAL (SELECT string_agg(d.channel || ':' || d.status, ',' ORDER BY d.channel) AS how FROM notification_deliveries d
                        WHERE d.dedupe_key = lc.dedupe_key AND d.channel <> 'IN_APP') hw ON TRUE
    LEFT JOIN LATERAL (SELECT d.id AS manual_id FROM notification_deliveries d WHERE d.member_id = x.id AND d.channel = 'WHATSAPP_MANUAL'
                        AND d.status IN ('QUEUED', 'LINK_OPENED') AND d.event IN ('MEMBERSHIP_EXPIRY', 'DUES_REMINDER') ORDER BY d.created_at DESC LIMIT 1) mw ON TRUE
    WHERE x.status = 'EXPIRING' OR x.dues > 0 OR (x.status = 'EXPIRED' AND le.last_end >= ${ctx.today}::date - 60)`,
  search: ["b.name", "b.phone", "b.code"],
  facets: [
    { key: "why", label: "Why", expr: "CASE WHEN b.dues > 0 AND b.status IN ('EXPIRING', 'EXPIRED') THEN 'both' WHEN b.dues > 0 THEN 'dues' WHEN b.status = 'EXPIRING' THEN 'expiring' ELSE 'expired' END", options: [
      { value: "expiring", label: "Expiring ≤ 7 days" }, { value: "expired", label: "Expired (last 60 days)" }, { value: "dues", label: "Dues only" }, { value: "both", label: "Dues and renewal" },
    ] },
    { key: "tier", label: "Tier", expr: "b.tier", options: [{ value: "GOLD", label: "Gold" }, { value: "SILVER", label: "Silver" }, { value: "JUNIOR", label: "Junior" }, { value: "WALK_IN", label: "No current plan" }] },
    { key: "contacted", label: "Contacted", expr: "CASE WHEN b.last_contact_at IS NULL THEN 'never' WHEN b.manual_id IS NOT NULL THEN 'pending' ELSE 'yes' END", options: [
      { value: "never", label: "Not yet" }, { value: "pending", label: "WhatsApp to send" }, { value: "yes", label: "Told" },
    ] },
  ],
  sorts: {
    ends: { label: "Ending soonest", sql: "COALESCE(b.ends_on, b.last_end) ASC NULLS LAST, b.name" },
    dues: { label: "Most due", sql: "b.dues DESC, b.name" },
    contact: { label: "Longest since contact", sql: "b.last_contact_at ASC NULLS FIRST, b.name" },
  },
  defaultSort: "ends",
  summary: [
    { key: "expiring", label: "Expiring ≤ 7 days", sql: "count(*) FILTER (WHERE b.status = 'EXPIRING')", format: "count", apply: { why: "expiring,both" } },
    { key: "expired", label: "Expired, not renewed", sql: "count(*) FILTER (WHERE b.status = 'EXPIRED')", format: "count", apply: { why: "expired" } },
    { key: "dues", label: "Dues", sql: "COALESCE(sum(b.dues), 0)", format: "money", apply: { why: "dues,both" } },
    { key: "pending", label: "WhatsApp to send", sql: "count(*) FILTER (WHERE b.manual_id IS NOT NULL)", format: "count", apply: { contacted: "pending" } },
  ],
  csv: [
    { key: "code", label: "Member code" }, { key: "name", label: "Name" }, { key: "phone", label: "Mobile" }, { key: "tier", label: "Tier" }, { key: "status", label: "Membership" },
    { key: "ends_on", label: "Ends", format: "date" }, { key: "last_end", label: "Last end", format: "date" }, { key: "dues", label: "Dues (₹)", format: "money" },
    { key: "last_contact_at", label: "Last contact", format: "datetime" }, { key: "last_event", label: "Last message" }, { key: "how", label: "How" },
  ],
};
