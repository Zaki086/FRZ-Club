// v3 §3.2: the message log (Owner) — every email the app delivered or failed to deliver, and every WhatsApp message
// staff opened. The log grows without limit, so the date range is applied inside the base and it opens on 7 days.
import { Prisma } from "@prisma/client";
import { istDayRange } from "@/lib/time";
import type { ListDef } from "./core";

export const messagesList: ListDef = {
  name: "messages",
  title: "Message log",
  view: ["messages.log"],
  exportCaps: ["messages.log"],
  base: (ctx) => Prisma.sql`
    SELECT ml.id, ml.channel, ml."to" AS recipient, ml.subject, ml.body, ml.status, ml.error, ml.entity, ml.entity_id, ml.actor_id,
      u.name AS actor_name, ml.at, ml.job_id -- v6 SA-11: the "Send all" job that sent it
    FROM message_log ml
    LEFT JOIN users u ON u.id = ml.actor_id
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND ml.at >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND ml.at < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.recipient", "b.subject", "b.body", "b.job_id"],
  dateColumn: { expr: "b.at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "channel", label: "Channel", expr: "b.channel", options: [{ value: "EMAIL", label: "Email" }, { value: "WHATSAPP", label: "WhatsApp" }, { value: "PUSH", label: "Push" }] },
    // v6 SA-11: every message a "Send all" job sent, by job.
    { key: "job", label: "Send all job", expr: "b.job_id" },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "SENT", label: "Sent" }, { value: "FAILED", label: "Failed" }, { value: "OPENED", label: "Opened (WhatsApp)" }] },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.at DESC, b.id" },
    oldest: { label: "Oldest first", sql: "b.at ASC, b.id" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "LAST_7" }),
  summary: [
    { key: "sent", label: "Sent", sql: "count(*) FILTER (WHERE b.status = 'SENT')", format: "count", apply: { status: "SENT" } },
    { key: "failed", label: "Failed", sql: "count(*) FILTER (WHERE b.status = 'FAILED')", format: "count", apply: { status: "FAILED" } },
    { key: "opened", label: "WhatsApp opened", sql: "count(*) FILTER (WHERE b.status = 'OPENED')", format: "count", apply: { status: "OPENED" } },
  ],
  csv: [
    { key: "at", label: "When", format: "datetime" }, { key: "channel", label: "Channel" }, { key: "recipient", label: "To" }, { key: "subject", label: "Subject" },
    { key: "body", label: "Message" }, { key: "status", label: "Status" }, { key: "error", label: "Error" }, { key: "actor_name", label: "By" },
    { key: "job_id", label: "Send all job" },
  ],
};

// ───────── v4 §5.4 step 8 (PUSH): every automatic WhatsApp message ─────────

/** WhatsApp templates (whatsapp/templates.ts) as FilterBar options. */
export const WA_TEMPLATE_OPTIONS = [
  "club_session_cancelled", "booking_cancelled_refund", "booking_rescheduled", "cancellation_choice_reminder", "refund_ready_to_collect",
  "refund_completed", "refund_rejected", "refund_unclaimed_reminder", "membership_welcome", "membership_expiring", "dues_reminder",
].map((t) => ({ value: t, label: t }));

/** One status per message, from its timeline: queued → (retrying) → sent → delivered → read, or failed / not automatic. */
export const WA_LOG_STATUS = `CASE
  WHEN b.status = 'FAILED' THEN 'FAILED'
  WHEN b.status = 'SKIPPED' THEN 'NOT_AUTOMATIC'
  WHEN b.wa_status = 'read' THEN 'READ'
  WHEN b.status = 'DELIVERED' THEN 'DELIVERED'
  WHEN b.status = 'SENT' THEN 'SENT'
  WHEN b.attempts > 0 THEN 'RETRYING'
  ELSE 'QUEUED' END`;

export const WA_LOG_STATUS_OPTIONS = [
  { value: "QUEUED", label: "Queued" }, { value: "RETRYING", label: "Retrying" }, { value: "SENT", label: "Sent" }, { value: "DELIVERED", label: "Delivered" },
  { value: "READ", label: "Read" }, { value: "FAILED", label: "Failed" }, { value: "NOT_AUTOMATIC", label: "Not sent automatically" },
];

/**
 * The Owner's WhatsApp log: each automatic message (and each one that could not go automatically — why, and that the
 * desk got it by hand) with its template, the recipient with a masked number, the status timeline (queued, sent,
 * delivered, read, failed — with times), the error and the number of tries.
 */
export const whatsappLogList: ListDef = {
  name: "whatsapp-log",
  title: "WhatsApp messages",
  view: ["messages.log"],
  exportCaps: ["messages.log"],
  base: () => Prisma.sql`
    SELECT d.id, d.event, d.wa_template, d.status, d.wa_status, d.attempts, d.error, d.wa_error_code, d.title, d.body,
      d.created_at AS queued_at, COALESCE(d.wa_sent_at, d.sent_at) AS sent_at, d.delivered_at, d.wa_read_at AS read_at,
      CASE WHEN d.status = 'FAILED' THEN COALESCE(d.wa_failed_at, d.updated_at) END AS failed_at,
      CASE WHEN d.status = 'QUEUED' THEN d.not_before END AS next_try_at,
      CASE WHEN d.to_address IS NULL THEN NULL ELSE '+91 ••••••' || right(d.to_address, 4) END AS recipient_phone,
      right(COALESCE(d.to_address, ''), 4) AS phone_last4,
      COALESCE(u.name, g.name || ' (guest)') AS recipient, d.member_id, m.member_code,
      mt.status AS manual_status
    FROM notification_deliveries d
    LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN guests g ON g.id = d.guest_id
    LEFT JOIN members m ON m.id = d.member_id
    LEFT JOIN notification_deliveries mt ON mt.dedupe_key = d.dedupe_key AND mt.channel = 'WHATSAPP_MANUAL'
    WHERE d.channel = 'WHATSAPP_API' AND d.wa_template IS NOT NULL`,
  search: ["b.recipient", "b.member_code", "b.phone_last4", "b.title"],
  dateColumn: { expr: "b.queued_at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "event", label: "Event", expr: "b.event" },
    { key: "template", label: "Template", expr: "b.wa_template", options: WA_TEMPLATE_OPTIONS },
    { key: "status", label: "Status", expr: WA_LOG_STATUS, options: WA_LOG_STATUS_OPTIONS },
  ],
  sorts: {
    newest: { label: "Newest first", sql: "b.queued_at DESC, b.id" },
    oldest: { label: "Oldest first", sql: "b.queued_at ASC, b.id" },
  },
  defaultSort: "newest",
  defaults: () => ({ range: "LAST_7" }),
  summary: [
    { key: "sent", label: "Sent, delivered or read", sql: `count(*) FILTER (WHERE (${WA_LOG_STATUS}) IN ('SENT', 'DELIVERED', 'READ'))`, format: "count", apply: { status: "SENT,DELIVERED,READ" } },
    { key: "waiting", label: "Queued or retrying", sql: `count(*) FILTER (WHERE (${WA_LOG_STATUS}) IN ('QUEUED', 'RETRYING'))`, format: "count", apply: { status: "QUEUED,RETRYING" } },
    { key: "failed", label: "Failed", sql: `count(*) FILTER (WHERE (${WA_LOG_STATUS}) = 'FAILED')`, format: "count", apply: { status: "FAILED" } },
    { key: "manual", label: "Not sent automatically", sql: `count(*) FILTER (WHERE (${WA_LOG_STATUS}) = 'NOT_AUTOMATIC')`, format: "count", apply: { status: "NOT_AUTOMATIC" } },
  ],
  csv: [
    { key: "queued_at", label: "Queued", format: "datetime" }, { key: "event", label: "Event" }, { key: "wa_template", label: "Template" },
    { key: "recipient", label: "Recipient" }, { key: "recipient_phone", label: "Number" }, { key: "status", label: "Status" },
    { key: "sent_at", label: "Sent", format: "datetime" }, { key: "delivered_at", label: "Delivered", format: "datetime" }, { key: "read_at", label: "Read", format: "datetime" },
    { key: "failed_at", label: "Failed", format: "datetime" }, { key: "attempts", label: "Tries" }, { key: "error", label: "Error / reason" },
  ],
};
