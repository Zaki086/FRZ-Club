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
      u.name AS actor_name, ml.at
    FROM message_log ml
    LEFT JOIN users u ON u.id = ml.actor_id
    WHERE TRUE
    ${ctx.from ? Prisma.sql`AND ml.at >= ${istDayRange(ctx.from)[0]}` : Prisma.empty}
    ${ctx.to ? Prisma.sql`AND ml.at < ${istDayRange(ctx.to)[1]}` : Prisma.empty}`,
  search: ["b.recipient", "b.subject", "b.body"],
  dateColumn: { expr: "b.at", label: "Date", kind: "timestamp" },
  facets: [
    { key: "channel", label: "Channel", expr: "b.channel", options: [{ value: "EMAIL", label: "Email" }, { value: "WHATSAPP", label: "WhatsApp" }] },
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
  ],
};
