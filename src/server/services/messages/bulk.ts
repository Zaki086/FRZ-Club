// v5 §3.4: bulk sends from a list — the selected rows or everyone matching the list's current filter (max 500).
//  - Preview: the first 3 recipients rendered, who is skipped and why, who got this template in the last 24 h.
//  - Email, push and automatic WhatsApp: queued and sent by the messages worker at ≤ 1 message per second (a rate gate
//    row shared by every worker process), with progress and a summary when done.
//  - WhatsApp by hand: one task per recipient in "Messages to send" (the "Send next" flow opens them in turn).
//  - Consent: ANNOUNCEMENT skips anyone who unsubscribed from announcement emails, replied STOP / opted out of WhatsApp
//    or has no push device; TRANSACTIONAL still respects the WhatsApp opt-out. Skipped people are listed in the summary.
import type { MessageTemplate, NotificationDelivery } from "@prisma/client";
import { clock } from "@/lib/clock";
import { prisma, withTx } from "../../db";
import { DomainError } from "../../errors";
import { actorId, type Actor } from "../../rbac/actor";
import { assertCan, can } from "../../rbac/permissions";
import { audit } from "../audit";
import { getCapabilities } from "../capabilities";
import { dispatchWhatsApp } from "../channels";
import { checkinRisks, RISK_KINDS } from "../checkin-risk";
import { LISTS } from "../filters";
import { assertListAccess, runList } from "../filters/core";
import {
  BULK_MAX, TEMPLATE_CHANNELS,
  type BulkList, type BulkListItem, type BulkPreviewResponse, type BulkProgress, type BulkResponse, type BulkSkip, type ChannelCounts, type DeliveryChannel,
  type TemplateCategory, type TemplateChannel, type TemplateContext, type TemplateOverrides,
} from "./contract";
import {
  assertCanSendCategory, assertFilledIn, availability, clubInfo, deliverRow, planRows, QUEUE_MARK, recentSends, recipientKey, renderParts, renderedMessage,
  RUN_PREFIX, sendableTemplate, toRecipient, writeRows, type PlannedRow,
} from "./delivery";
import { loadRecord, type LoadedRecord } from "./records";
import { bulkSchema, type BulkInput } from "./schemas";

/** Lists of members vs the Leads Board, and the template contexts each may use. */
const LIST_KIND: Record<BulkList, { recipients: "member" | "lead"; contexts: TemplateContext[] }> = {
  members: { recipients: "member", contexts: ["MEMBER", "GENERAL"] },
  renewals: { recipients: "member", contexts: ["MEMBER", "GENERAL"] },
  "checkin-risk": { recipients: "member", contexts: ["MEMBER", "GENERAL"] },
  leads: { recipients: "lead", contexts: ["LEAD", "GENERAL"] },
};

/** §3.4: Members is the Manager's (and Owner's); Renewal & Dues, Check-in Risk and the Leads Board also the front desk's. */
function assertBulkList(actor: Actor, list: BulkList) {
  assertCan(actor, "messages.bulk");
  if (list === "members") assertCan(actor, "messages.bulk_members");
}

const tooMany = (n: number) => new DomainError("VALIDATION_FAILED", `${n} people match this filter — narrow it to ${BULK_MAX} or fewer.`, { total: n, max: BULK_MAX });

/** Everyone the bulk send goes to: the selected ids, or every row matching the list's current filter (≤ 500). */
async function recipientIds(actor: Actor, input: BulkInput): Promise<string[]> {
  const list = input.list;
  if (list === "checkin-risk") {
    assertCan(actor, "checkin");
    if (input.ids?.length) return [...new Set(input.ids)];
    const risk = await checkinRisks(actor);
    const f = new URLSearchParams(input.filter ?? "");
    const scope = f.get("scope") === "today" ? "today" : "soon";
    const kind = f.get("kind");
    if (kind && !(RISK_KINDS as readonly string[]).includes(kind)) throw new DomainError("VALIDATION_FAILED", `Unknown problem filter "${kind}".`);
    const ids = risk.arrivals
      .filter((a) => scope === "today" || a.soon)
      .flatMap((a) => a.risks.filter((r) => !kind || r.kind === kind).map((r) => r.memberId))
      .filter((x): x is string => !!x);
    const unique = [...new Set(ids)];
    if (unique.length > BULK_MAX) throw tooMany(unique.length);
    return unique;
  }
  const def = LISTS[list];
  assertListAccess(def, actor);
  if (input.ids?.length) return [...new Set(input.ids)];
  const params = Object.fromEntries([...new URLSearchParams(input.filter ?? "")].filter(([k]) => k !== "page" && k !== "size"));
  const out: string[] = [];
  for (let page = 1; page <= Math.ceil(BULK_MAX / 100); page++) {
    const r = await runList(def, actor, { ...params, size: "100", page: String(page) });
    if (r.total > BULK_MAX) throw tooMany(r.total);
    out.push(...r.rows.map((row) => String(row.id)));
    if (out.length >= r.total || page >= r.pages) break;
  }
  return [...new Set(out)];
}

type Planned = { rec: LoadedRecord; channels: TemplateChannel[]; devices: Array<{ id: string; userAgent: string | null }>; auto: boolean };
type Plan = {
  template: MessageTemplate;
  recipients: Planned[];
  skipped: BulkSkip[];
  duplicates: Array<{ name: string; lastSentAt: string }>;
  selected: number;
};

/** Who gets what: per recipient the chosen channels they can receive; the rest is listed as skipped with the reason. */
async function plan(actor: Actor, input: BulkInput): Promise<Plan> {
  assertBulkList(actor, input.list);
  const t = await sendableTemplate(input.templateId);
  assertCanSendCategory(actor, t.category);
  const kind = LIST_KIND[input.list];
  if (!kind.contexts.includes(t.context as TemplateContext)) {
    throw new DomainError("VALIDATION_FAILED", `"${t.name}" is a ${t.context.toLowerCase()} template — choose a ${kind.recipients} template (or a general one) for this list.`);
  }
  const chosen = input.channels.filter((c) => t.channels.includes(c));
  const missing = input.channels.filter((c) => !t.channels.includes(c));
  if (missing.length) throw new DomainError("CHANNEL_NOT_AVAILABLE", `"${t.name}" has no ${missing.join(" / ").toLowerCase()} text.`, { channel: missing[0], reason: "not in the template" });
  const ids = await recipientIds(actor, input);
  if (!ids.length) throw new DomainError("VALIDATION_FAILED", "Nobody is selected.");
  if (ids.length > BULK_MAX) throw tooMany(ids.length);
  const caps = await getCapabilities();
  const recs: LoadedRecord[] = [];
  const skipped: BulkSkip[] = [];
  for (const id of ids) {
    try {
      recs.push(await loadRecord(t.context === "GENERAL" ? "GENERAL" : (t.context as TemplateContext), id));
    } catch {
      skipped.push({ name: id, reason: kind.recipients === "lead" ? "Lead not found" : "Member not found" });
    }
  }
  const userIds = recs.map((r) => r.person?.userId ?? null).filter((x): x is string => !!x);
  const subs = userIds.length ? await prisma.pushSubscription.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true, userAgent: true }, orderBy: { createdAt: "asc" } }) : [];
  const recipients: Planned[] = [];
  for (const rec of recs) {
    const p = rec.person;
    if (!p) {
      skipped.push({ name: rec.label, reason: "No contact details (personal data erased)" });
      continue;
    }
    const devices = subs.filter((s) => s.userId === p.userId).map((s) => ({ id: s.id, userAgent: s.userAgent }));
    const av = await availability(t, rec, devices.length, caps);
    const ok = chosen.filter((c) => av.options.find((o) => o.channel === c)?.available);
    const no = chosen.filter((c) => !ok.includes(c));
    if (!ok.length) {
      skipped.push({ name: p.name, reason: no.map((c) => av.options.find((o) => o.channel === c)!.reason).join("; ") });
      continue;
    }
    for (const c of no) skipped.push({ name: p.name, reason: av.options.find((o) => o.channel === c)!.reason ?? "Not available", channel: c });
    recipients.push({ rec, channels: ok, devices, auto: av.auto });
  }
  const recent = await recentSends(t.id, recipients.map((r) => recipientKey(r.rec.person!)));
  const duplicates = recipients
    .filter((r) => recent.has(recipientKey(r.rec.person!)))
    .map((r) => ({ name: r.rec.person!.name, lastSentAt: recent.get(recipientKey(r.rec.person!))!.at.toISOString() }));
  return { template: t, recipients, skipped, duplicates, selected: ids.length };
}

function perChannel(recipients: Planned[]): Record<TemplateChannel, number> {
  const out = Object.fromEntries(TEMPLATE_CHANNELS.map((c) => [c, 0])) as Record<TemplateChannel, number>;
  for (const r of recipients) for (const c of r.channels) out[c] += c === "PUSH" ? r.devices.length : 1;
  return out;
}

/** POST /api/messages/bulk/preview */
export async function previewBulkSend(actor: Actor, raw: unknown): Promise<BulkPreviewResponse> {
  const input = bulkSchema.parse(raw);
  const p = await plan(actor, input);
  const club = await clubInfo();
  const sample = p.recipients.slice(0, 3).map((r) => {
    const parts = renderParts(p.template, r.rec, club, input.overrides as TemplateOverrides | undefined);
    return { recipient: toRecipient(r.rec.person!, r.devices.length), channels: r.channels, rendered: renderedMessage(parts, r.channels, r.rec.person, club, p.template.category, r.rec.person!.kind) };
  });
  return { total: p.recipients.length, perChannel: perChannel(p.recipients), sample, skipped: p.skipped, duplicates: p.duplicates };
}

/** POST /api/messages/bulk — write every message (queued for the worker, or a manual task) and return the summary. */
export async function createBulkSend(actor: Actor, raw: unknown): Promise<BulkResponse> {
  const input = bulkSchema.parse(raw);
  const p = await plan(actor, input);
  if (!p.recipients.length) throw new DomainError("VALIDATION_FAILED", "None of the selected people can receive this message on the chosen channels.", { skipped: p.skipped });
  if (p.duplicates.length && !input.confirmDuplicate) {
    throw new DomainError("DUPLICATE_RECENT_SEND", `${p.duplicates.length} of them already got "${p.template.name}" in the last 24 hours. Send it to them again?`, {
      lastSentAt: p.duplicates[0].lastSentAt, sentBy: null, recipients: p.duplicates,
    });
  }
  const club = await clubInfo();
  const overrides = input.overrides as TemplateOverrides | undefined;
  const bulkId = `mb_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const rows: PlannedRow[] = [];
  for (const r of p.recipients) {
    const parts = renderParts(p.template, r.rec, club, overrides);
    assertFilledIn(parts, r.channels);
    const auto = !!input.autoWhatsApp && r.channels.includes("WHATSAPP") && r.auto;
    rows.push(...(await planRows(
      { template: p.template, rec: r.rec, person: r.rec.person!, sendId: `${bulkId}:${recipientKey(r.rec.person!)}`, bulkId, actor },
      parts, r.channels, { autoWhatsApp: auto, claim: QUEUE_MARK, devices: r.devices },
    )));
  }
  await withTx(async (tx) => {
    await tx.messageBulkSend.create({
      data: {
        id: bulkId, templateId: p.template.id, templateVersion: p.template.version, list: input.list, filter: input.ids?.length ? null : input.filter ?? "",
        selected: p.selected, channels: input.channels, autoWhatsapp: !!input.autoWhatsApp, overrides: overrides ?? undefined,
        status: rows.some((r) => r.handledBy === QUEUE_MARK) ? "QUEUED" : "DONE", total: p.recipients.length, skipped: p.skipped,
        createdBy: actorId(actor), finishedAt: rows.some((r) => r.handledBy === QUEUE_MARK) ? null : clock.now(),
      },
    });
    await writeRows(tx, rows);
    await audit(tx, actor, "message.bulk_send", "message_bulk_send", bulkId, {
      after: {
        template: p.template.name, version: p.template.version, list: input.list, filter: input.ids?.length ? null : input.filter ?? "", selected: p.selected,
        recipients: p.recipients.length, skipped: p.skipped.length, channels: input.channels, duplicatesConfirmed: p.duplicates.length,
      },
    });
  });
  return { bulkId, total: p.recipients.length, skipped: p.skipped };
}

// ───────── the messages worker (≤ 1 message per second) ─────────

export const BULK_RATE_MS = 1000;
const STALE_MS = 10 * 60_000;
const GATE = "bulk";

type QueueOpts = {
  /** Stop after this long (ms of the injectable clock) — the worker runs every minute with ~55 s. */
  budgetMs?: number;
  /** At most this many messages in this run. */
  maxMessages?: number;
  /** Wait (tests pass one that moves the pinned clock). */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Take the permit to send one message now: the gate's last send is ≥ 1 s ago. Returns ms to wait when not yet. */
async function takePermit(): Promise<number> {
  const now = clock.now();
  await prisma.$executeRaw`INSERT INTO message_rate_gate (id, last_sent_at, updated_at) VALUES (${GATE}, 'epoch', ${now}) ON CONFLICT (id) DO NOTHING`;
  const took = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE message_rate_gate SET last_sent_at = ${now}, updated_at = ${now}
     WHERE id = ${GATE} AND last_sent_at <= ${new Date(now.getTime() - BULK_RATE_MS)} RETURNING id`;
  if (took.length) return 0;
  const g = await prisma.messageRateGate.findUnique({ where: { id: GATE } });
  return Math.max(1, (g ? g.lastSentAt.getTime() + BULK_RATE_MS : now.getTime()) - now.getTime());
}

/** Claim the oldest due queued message (SKIP LOCKED: two workers never take the same row). */
async function claimNext(run: string): Promise<NotificationDelivery | null> {
  const now = clock.now();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH due AS (
      SELECT id FROM notification_deliveries
       WHERE status = 'QUEUED' AND handled_by = ${QUEUE_MARK} AND channel IN ('EMAIL', 'PUSH', 'WHATSAPP_API')
         AND (not_before IS NULL OR not_before <= ${now})
       ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE notification_deliveries d SET handled_by = ${run}, updated_at = ${now} FROM due WHERE d.id = due.id RETURNING d.id`;
  return rows.length ? prisma.notificationDelivery.findUnique({ where: { id: rows[0].id } }) : null;
}

async function anyDue(): Promise<boolean> {
  const now = clock.now();
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM notification_deliveries
     WHERE status = 'QUEUED' AND handled_by = ${QUEUE_MARK} AND channel IN ('EMAIL', 'PUSH', 'WHATSAPP_API') AND (not_before IS NULL OR not_before <= ${now})
     LIMIT 1`;
  return rows.length > 0;
}

/**
 * Worker job (every minute): send queued template messages — bulk email, push and automatic WhatsApp, and any single
 * send whose request died before it finished — at most one per second across every worker. Then mark finished bulk
 * sends DONE. Idempotent: every row is claimed before it is sent.
 */
export async function processMessageQueue(opts: QueueOpts = {}): Promise<{ sent: number; failed: number }> {
  const sleep = opts.sleep ?? realSleep;
  const budget = opts.budgetMs ?? 55_000;
  const max = opts.maxMessages ?? Number.POSITIVE_INFINITY;
  const started = clock.now().getTime();
  const result = { sent: 0, failed: 0 };
  // A run that died mid-send leaves its claim: after 10 minutes the row is queued again.
  await prisma.notificationDelivery.updateMany({
    where: { status: "QUEUED", handledBy: { startsWith: RUN_PREFIX }, updatedAt: { lt: new Date(clock.now().getTime() - STALE_MS) } },
    data: { handledBy: QUEUE_MARK, updatedAt: clock.now() },
  });
  const run = `${RUN_PREFIX}w${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const touched = new Set<string>();
  while (result.sent + result.failed < max && clock.now().getTime() - started < budget) {
    if (!(await anyDue())) break;
    const wait = await takePermit();
    if (wait > 0) {
      if (clock.now().getTime() + wait - started >= budget) break;
      await sleep(wait);
      continue;
    }
    const d = await claimNext(run);
    if (!d) continue;
    if (d.bulkId && !touched.has(d.bulkId)) {
      touched.add(d.bulkId);
      await prisma.messageBulkSend.updateMany({ where: { id: d.bulkId, status: "QUEUED" }, data: { status: "SENDING", startedAt: clock.now(), updatedAt: clock.now() } });
    }
    if (d.channel === "WHATSAPP_API") {
      // v4 §5.4: the WhatsApp queue sends it (retries, rate-limit pause and the manual fallback included).
      await prisma.notificationDelivery.update({ where: { id: d.id }, data: { handledBy: null } });
      const r = await dispatchWhatsApp([d.id]);
      result.sent += r.sent;
      result.failed += r.failed;
      continue;
    }
    const status = await deliverRow(d);
    if (status === "SENT") result.sent++;
    else result.failed++;
  }
  await backfillFallbackRows();
  await finishBulkSends();
  return result;
}

/**
 * An automatic WhatsApp that failed becomes a manual task (v4 WA-53, channels.ts `whatsappFallback`) with the same
 * dedupe key: give that task the template, version, recipient and send of the message it replaces (MT-6).
 */
async function backfillFallbackRows() {
  await prisma.$executeRaw`
    UPDATE notification_deliveries m SET template_id = d.template_id, template_version = d.template_version, template_context = d.template_context,
           template_category = d.template_category, record_id = d.record_id, recipient_key = d.recipient_key, lead_id = d.lead_id,
           to_masked = d.to_masked, send_id = d.send_id, bulk_id = d.bulk_id
      FROM notification_deliveries d
     WHERE d.channel = 'WHATSAPP_API' AND d.status = 'FAILED' AND d.template_id IS NOT NULL
       AND m.dedupe_key = d.dedupe_key AND m.channel = 'WHATSAPP_MANUAL' AND m.template_id IS NULL`;
}

/** A bulk send is DONE when none of its email / push / automatic WhatsApp messages is still queued. */
async function finishBulkSends() {
  const now = clock.now();
  await prisma.$executeRaw`
    UPDATE message_bulk_sends b SET status = 'DONE', finished_at = ${now}, updated_at = ${now}
     WHERE b.status <> 'DONE'
       AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.bulk_id = b.id AND d.status = 'QUEUED' AND d.channel IN ('EMAIL', 'PUSH', 'WHATSAPP_API'))`;
}

// ───────── progress and summary ─────────

function assertCanSee(actor: Actor) {
  if (!can(actor, "messages.bulk")) assertCan(actor, "messages.bulk");
}

const zero = (): ChannelCounts => ({ total: 0, queued: 0, sent: 0, failed: 0, linkOpened: 0 });

/** GET /api/messages/bulk/[id] */
export async function bulkProgress(actor: Actor, id: string): Promise<BulkProgress> {
  assertCanSee(actor);
  const b = await prisma.messageBulkSend.findUnique({ where: { id } });
  if (!b) throw new DomainError("NOT_FOUND", "Bulk send was not found.");
  const [t, counts, next, creator] = await Promise.all([
    prisma.messageTemplate.findUniqueOrThrow({ where: { id: b.templateId }, select: { id: true, name: true, category: true } }),
    prisma.notificationDelivery.groupBy({ by: ["channel", "status"], where: { bulkId: id }, _count: { _all: true } }),
    prisma.notificationDelivery.findFirst({ where: { bulkId: id, channel: "WHATSAPP_MANUAL", status: { in: ["QUEUED", "LINK_OPENED"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } }),
    b.createdBy ? prisma.user.findUnique({ where: { id: b.createdBy }, select: { name: true } }) : null,
  ]);
  const per: Partial<Record<DeliveryChannel, ChannelCounts>> = {};
  for (const c of counts) {
    const ch = c.channel as DeliveryChannel;
    const x = (per[ch] ??= zero());
    const n = c._count._all;
    x.total += n;
    if (c.status === "QUEUED") x.queued += n;
    else if (c.status === "SENT" || c.status === "DELIVERED") x.sent += n;
    else if (c.status === "FAILED") x.failed += n;
    else if (c.status === "LINK_OPENED") x.linkOpened += n;
  }
  const queued = zero();
  for (const ch of ["EMAIL", "PUSH", "WHATSAPP_API"] as const) {
    const x = per[ch];
    if (!x) continue;
    queued.total += x.total; queued.queued += x.queued; queued.sent += x.sent; queued.failed += x.failed;
  }
  const manual = per.WHATSAPP_MANUAL ?? zero();
  const status = b.status === "DONE" || queued.queued === 0 ? "DONE" : b.status === "QUEUED" ? "QUEUED" : "SENDING";
  return {
    id: b.id, status, template: { id: t.id, name: t.name, version: b.templateVersion, category: t.category as TemplateCategory },
    list: b.list as BulkList, channels: b.channels as TemplateChannel[], createdAt: b.createdAt.toISOString(), createdBy: creator?.name ?? null,
    finishedAt: b.finishedAt?.toISOString() ?? null, total: b.total, queued, perChannel: per,
    manual: { total: manual.total, toSend: manual.queued, opened: manual.linkOpened, sent: manual.sent, nextId: next?.id ?? null },
    skipped: (b.skipped as BulkSkip[]) ?? [], etaSeconds: Math.ceil((queued.queued * BULK_RATE_MS) / 1000),
  };
}

/** GET /api/messages/bulk — the latest bulk sends (the front desk sees its own). */
export async function listBulkSends(actor: Actor, q: { limit?: number } = {}): Promise<BulkListItem[]> {
  assertCanSee(actor);
  const own = !can(actor, "messages.bulk_members") ? { createdBy: actorId(actor) } : {};
  const rows = await prisma.messageBulkSend.findMany({ where: own, orderBy: { createdAt: "desc" }, take: q.limit ?? 10 });
  const out: BulkListItem[] = [];
  for (const r of rows) {
    const p = await bulkProgress(actor, r.id);
    out.push({ id: p.id, status: p.status, template: p.template, list: p.list, channels: p.channels, createdAt: p.createdAt, createdBy: p.createdBy, total: p.total, finishedAt: p.finishedAt });
  }
  return out;
}
