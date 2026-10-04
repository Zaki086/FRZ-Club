// v6 §1 URL-3 + §2.2 (SENDALL): the manual WhatsApp queue ("Messages to send") kept clean and rendered late.
//
// URL-3 — render at open/send time. A queued message stores what it is made of in `render_spec`, not only its final
// text: system events keep their title/body with the public origin replaced by the token {{app.url}} (+ the in-app
// path and the WhatsApp API template values); v5 template messages keep the template id + version, the variables and
// the record. The text and every link are built when the task is opened (the wa.me link is made then) or when the
// email / push / WhatsApp message is sent, with the APP_URL of that moment — a changed APP_URL never leaves stale
// links. Rows made before v6 (no `render_spec`) keep using their stored text (LINKS' repair script fixes their origin).
//
// SA-1 `isStillRelevant(task)`: a dues reminder whose bill is now paid or void, an expiry reminder for a membership
// that has been renewed, a refund that was collected or cancelled, a club-cancellation choice already made or past its
// deadline, an order / racket already collected, a welcome / login link for someone who already set a password →
// SKIPPED_NOT_RELEVANT with the reason. SA-2: the same event + recipient + record → only the newest is kept, the others
// SKIPPED_DUPLICATE. SA-3: older than `manual_message_max_age_days` → EXPIRED (left out of "Send all"; still sendable
// one by one after a confirmation).
//
// SA-0 (hard rule): automatic WhatsApp only ever goes through the official WhatsApp Cloud API (whatsapp/*). Nothing
// here — or anywhere in the app — automates WhatsApp Web / Desktop, simulates clicks or uses unofficial libraries.
import type { NotificationDelivery } from "@prisma/client";
import { clock } from "@/lib/clock";
import { absoluteUrl, publicOrigin } from "@/lib/url";
import { prisma, type Tx } from "../../db";
import { type Actor } from "../../rbac/actor";
import { audit } from "../audit";
import { billDue } from "../bills";
import { getSettings } from "../settings";
import type { WaMessage } from "../whatsapp/templates";
import { renderText, type RenderValues } from "./variables";

// ───────── URL-3: render specs ─────────

/** Stands for the public origin (APP_URL) inside stored text; replaced when the message is opened or sent. */
export const ORIGIN_TOKEN = "{{app.url}}";

/** The current public origin in a text → the token (so the stored text never pins an address). */
export function tokenizeOrigin(text: string): string;
export function tokenizeOrigin(text: string | null): string | null;
export function tokenizeOrigin(text: string | null): string | null {
  const origin = publicOrigin();
  if (text == null || !origin) return text;
  return text.split(origin).join(ORIGIN_TOKEN);
}

/** The token → the public origin of now. */
export function detokenize(text: string): string;
export function detokenize(text: string | null): string | null;
export function detokenize(text: string | null): string | null {
  if (text == null) return text;
  return text.split(ORIGIN_TOKEN).join(publicOrigin());
}

export type EventSpec = { v: 1; kind: "EVENT"; title: string; body: string; link: string | null; wa?: WaMessage | null };
export type TemplateSpec = {
  v: 1; kind: "TEMPLATE"; templateId: string; version: number; context: string; recordId: string; key: string | null;
  /** Every variable of the send ({{member.first_name}}, {{link}}, club.*, …), origin tokenised. */
  values: RenderValues;
  /** Text edited for this send only (origin tokenised). */
  overrides?: Record<string, string> | null;
  wa?: WaMessage | null;
};
export type RenderSpec = EventSpec | TemplateSpec;

/** URL-3 spec of a system event message (notifyMember / notifyGuest). */
export function eventSpec(m: { title: string; body: string; link?: string | null; wa?: WaMessage | null }): EventSpec {
  const link = m.link ? (/^https?:\/\//i.test(m.link) ? tokenizeOrigin(m.link) : m.link) : null;
  return { v: 1, kind: "EVENT", title: tokenizeOrigin(m.title), body: tokenizeOrigin(m.body), link, ...(m.wa ? { wa: m.wa } : {}) };
}

/** URL-3 spec of a template message (v5 composer / bulk). */
export function templateSpec(t: { id: string; version: number; context: string; key: string | null }, recordId: string, values: RenderValues, overrides?: Record<string, string> | null, wa?: WaMessage | null): TemplateSpec {
  const tok = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tokenizeOrigin(String(v ?? ""))]));
  return {
    v: 1, kind: "TEMPLATE", templateId: t.id, version: t.version, context: t.context, recordId, key: t.key, values: tok(values),
    ...(overrides && Object.keys(overrides).length ? { overrides: tok(overrides) } : {}), ...(wa ? { wa } : {}),
  };
}

export function parseSpec(json: unknown): RenderSpec | null {
  if (!json || typeof json !== "object") return null;
  const s = json as Partial<RenderSpec>;
  if (s.v !== 1) return null;
  if (s.kind === "EVENT" && typeof s.title === "string" && typeof s.body === "string") return s as EventSpec;
  if (s.kind === "TEMPLATE" && typeof s.templateId === "string" && typeof s.version === "number" && s.values && typeof s.values === "object") return s as TemplateSpec;
  return null;
}

/** The manual WhatsApp text of a system event: title, body and the absolute link (one per line). */
export function manualWhatsAppText(m: { title: string; body: string; link?: string | null }): string {
  return [m.title, m.body, m.link ? absoluteUrl(m.link) : ""].filter(Boolean).join("\n");
}

type VersionText = { whatsappText: string; emailSubject: string; emailBody: string; pushTitle: string; pushBody: string };
/** Template versions read while rendering (one lookup per template + version per run). */
export type RenderCache = Map<string, VersionText | null>;

async function versionText(templateId: string, version: number, cache?: RenderCache): Promise<VersionText | null> {
  const k = `${templateId}@${version}`;
  if (cache?.has(k)) return cache.get(k)!;
  const v = await prisma.messageTemplateVersion.findUnique({
    where: { templateId_version: { templateId, version } },
    select: { whatsappText: true, emailSubject: true, emailBody: true, pushTitle: true, pushBody: true },
  });
  cache?.set(k, v);
  return v;
}

export type RenderedDelivery = {
  /** Email subject / push title / the task's title. */
  title: string;
  /** Email body / push body / the event body. */
  body: string;
  /** Absolute link of the message (null: none). */
  link: string | null;
  /** The WhatsApp text (manual tasks and the log of automatic ones). */
  whatsappText: string;
  /** False: built from the stored text (a row made before v6). */
  fresh: boolean;
};

type Renderable = Pick<NotificationDelivery, "channel" | "title" | "body" | "link" | "whatsappText" | "renderSpec">;

/**
 * URL-3: the message as it goes out now — rendered from its spec with today's APP_URL; a row without a spec (made
 * before v6) falls back to its stored text.
 */
export async function renderDelivery(d: Renderable, cache?: RenderCache): Promise<RenderedDelivery> {
  const spec = parseSpec(d.renderSpec);
  const stored: RenderedDelivery = {
    title: d.title, body: d.body, link: d.link ? absoluteUrl(d.link) : null,
    whatsappText: d.whatsappText ?? manualWhatsAppText({ title: d.title, body: d.body, link: d.link }), fresh: false,
  };
  if (!spec) return stored;
  if (spec.kind === "EVENT") {
    const title = detokenize(spec.title);
    const body = detokenize(spec.body);
    const link = spec.link ? absoluteUrl(detokenize(spec.link)) : null;
    return { title, body, link, whatsappText: manualWhatsAppText({ title, body, link }), fresh: true };
  }
  const text = await versionText(spec.templateId, spec.version, cache);
  if (!text) return stored;
  const src: VersionText = { ...text };
  for (const [k, v] of Object.entries(spec.overrides ?? {})) if (k in src && typeof v === "string") src[k as keyof VersionText] = detokenize(v);
  const values: RenderValues = Object.fromEntries(Object.entries(spec.values).map(([k, v]) => [k, detokenize(String(v ?? ""))]));
  const link = values.link ? absoluteUrl(values.link) : null;
  if (link) values.link = link;
  const whatsappText = renderText(src.whatsappText, values);
  if (d.channel === "EMAIL") return { title: renderText(src.emailSubject, values).replace(/\s+/g, " "), body: renderText(src.emailBody, values), link, whatsappText, fresh: true };
  if (d.channel === "PUSH") return { title: renderText(src.pushTitle, values).replace(/\s+/g, " "), body: renderText(src.pushBody, values), link, whatsappText, fresh: true };
  return { title: d.title, body: whatsappText, link, whatsappText, fresh: true };
}

// ───────── context ids (SA-1 / SA-2) ─────────

export type ContextIds = {
  billId?: string; invoiceId?: string; membershipId?: string; refundId?: string; clubCancellationId?: string; bookingId?: string;
  participantId?: string; orderId?: string; ticketId?: string; userId?: string;
  /** v5 template messages: the record's context and id, and the ready-made template key. */
  context?: string; recordId?: string; templateKey?: string | null;
};

const KEY_PATTERNS: Array<[RegExp, keyof ContextIds]> = [
  [/^dues:([^:]+)/, "billId"],
  [/^invoice-due:([^:]+)/, "invoiceId"],
  [/^membership-(?:reminder|welcome|paid):([^:]+)/, "membershipId"],
  [/^credentials:([^:]+)/, "userId"],
  [/^refund-[a-z-]+:([^:]+)/, "refundId"],
  [/^club-cancel-social:([^:]+)/, "participantId"],
  [/^club-cancel:([^:]+)/, "bookingId"],
  [/^(?:choice-reminder|club-reschedule|club-auto-refund):([^:]+)/, "clubCancellationId"],
  [/^booking-[a-z-]+:([^:]+)/, "bookingId"],
  [/^order-status:([^:]+)/, "orderId"],
  [/^restring-ready:([^:]+)/, "ticketId"],
];

/** The records a system message is about, read from its dedupe key (every v4 event key starts with them). */
export function contextIdsFromKey(dedupeKey: string): ContextIds {
  for (const [re, field] of KEY_PATTERNS) {
    const m = re.exec(dedupeKey);
    if (m) return { [field]: m[1] } as ContextIds;
  }
  return {};
}

type TaskRow = Pick<NotificationDelivery, "id" | "event" | "dedupeKey" | "userId" | "guestId" | "leadId" | "recipientKey" | "toAddress" | "createdAt" | "status" | "templateId" | "templateContext" | "recordId" | "contextIds">;

export async function templateKeyOf(templateId: string | null, cache: Map<string, string | null> = new Map()): Promise<string | null> {
  if (!templateId) return null;
  if (!cache.has(templateId)) cache.set(templateId, (await prisma.messageTemplate.findUnique({ where: { id: templateId }, select: { key: true } }))?.key ?? null);
  return cache.get(templateId)!;
}

/** The context ids of a task: stored (v6 rows), else read from its dedupe key or its template columns. */
export async function contextIdsOf(t: TaskRow, keys?: Map<string, string | null>): Promise<ContextIds> {
  const stored = t.contextIds && typeof t.contextIds === "object" ? (t.contextIds as ContextIds) : null;
  if (stored && Object.keys(stored).length) return stored;
  if (t.templateId) return { context: t.templateContext ?? undefined, recordId: t.recordId ?? undefined, templateKey: await templateKeyOf(t.templateId, keys) };
  return contextIdsFromKey(t.dedupeKey);
}

/** SA-2: "same event + recipient + context record". */
function groupKey(t: TaskRow, ids: ContextIds): string {
  const what = t.templateId ? `tpl:${ids.templateKey ?? t.templateId}` : t.event;
  const who = t.userId ?? t.guestId ?? t.leadId ?? t.recipientKey ?? t.toAddress ?? "?";
  const rec = ids.billId ?? ids.invoiceId ?? ids.membershipId ?? ids.refundId ?? ids.clubCancellationId ?? ids.bookingId ?? ids.participantId
    ?? ids.orderId ?? ids.ticketId ?? ids.recordId ?? ids.userId ?? t.dedupeKey;
  return `${what}|${who}|${rec}`;
}

// ───────── SA-1: is the message still relevant? ─────────

export type Relevance = { relevant: true } | { relevant: false; reason: string };
const yes: Relevance = { relevant: true };
const no = (reason: string): Relevance => ({ relevant: false, reason });

async function billCheck(billId: string): Promise<Relevance> {
  const b = await prisma.bill.findUnique({ where: { id: billId }, select: { status: true, total: true, amountPaid: true, amountRefunded: true, closedAt: true } });
  if (!b) return yes;
  if (b.status === "VOID") return no("The bill was voided");
  if (billDue(b) <= 0) return no(b.closedAt && b.status !== "PAID" ? "The bill was voided" : "The bill is paid");
  return yes;
}

async function invoiceCheck(invoiceId: string): Promise<Relevance> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, billId: true } });
  if (!inv) return yes;
  if (inv.status === "CANCELLED") return no("The invoice was cancelled");
  if (inv.status === "PAID") return no("The invoice is paid");
  return billCheck(inv.billId);
}

async function memberDuesCheck(memberId: string): Promise<Relevance> {
  const bills = await prisma.bill.findMany({ where: { memberId, closedAt: null }, select: { total: true, amountPaid: true, amountRefunded: true, closedAt: true } });
  return bills.reduce((a, b) => a + billDue(b), 0) > 0 ? yes : no("Nothing is due any more (the bills are paid)");
}

async function renewedCheck(membershipId: string): Promise<Relevance> {
  const ms = await prisma.membership.findUnique({ where: { id: membershipId }, select: { memberId: true, endDate: true } });
  if (!ms) return yes;
  const later = await prisma.membership.count({ where: { memberId: ms.memberId, id: { not: membershipId }, status: { in: ["ACTIVE", "SCHEDULED"] }, endDate: { gt: ms.endDate } } });
  return later ? no("The membership has been renewed") : yes;
}

async function memberRenewedSince(memberId: string, since: Date): Promise<Relevance> {
  const n = await prisma.membership.count({ where: { memberId, status: { in: ["ACTIVE", "SCHEDULED"] }, createdAt: { gt: since } } });
  return n ? no("The membership has been renewed") : yes;
}

async function passwordCheck(userId: string | null | undefined): Promise<Relevance> {
  if (!userId) return yes;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return u?.passwordHash ? no("The member has already set a password") : yes;
}

async function refundCheck(refundId: string): Promise<Relevance> {
  const r = await prisma.refundRequest.findUnique({ where: { id: refundId }, select: { status: true, collectStatus: true } });
  if (!r) return yes;
  if (r.collectStatus === "COLLECTED" || r.status === "COMPLETED") return no("The refund was collected");
  if (r.status !== "APPROVED" || r.collectStatus !== "READY_TO_COLLECT") return no("The refund was cancelled");
  return yes;
}

async function choiceCheck(cc: { status: string; deadlineAt: Date } | null): Promise<Relevance> {
  if (!cc) return yes;
  if (cc.status !== "PENDING_CHOICE") return no(`The member already chose (${cc.status === "RESCHEDULED" ? "rescheduled" : "refunded"})`);
  if (cc.deadlineAt.getTime() <= clock.now().getTime()) return no("The deadline to choose has passed");
  return yes;
}

async function orderCheck(id: string): Promise<Relevance> {
  const o = await prisma.shopOrder.findUnique({ where: { id }, select: { status: true } });
  if (o) {
    if (o.status === "COLLECTED" || o.status === "DELIVERED") return no("The order was already collected");
    if (o.status === "CANCELLED") return no("The order was cancelled");
    return yes;
  }
  const t = await prisma.serviceTicket.findUnique({ where: { id }, select: { status: true } });
  if (t?.status === "COLLECTED") return no("The racket was already collected");
  if (t?.status === "CANCELLED") return no("The restring was cancelled");
  return yes;
}

/**
 * SA-1: is this manual task still worth sending? (System events by event type; v5 template messages by their
 * ready-made template key and record.) Anything not in the SA-1 table stays relevant.
 */
export async function isStillRelevant(task: TaskRow, keys?: Map<string, string | null>): Promise<Relevance> {
  const ids = await contextIdsOf(task, keys);
  if (task.templateId) {
    const rid = ids.recordId;
    if (!rid) return yes;
    switch (ids.templateKey) {
      case "dues_reminder":
        if (ids.context === "BOOKING") {
          const b = await prisma.booking.findUnique({ where: { id: rid }, select: { billId: true } });
          return b?.billId ? billCheck(b.billId) : yes;
        }
        return memberDuesCheck(rid);
      case "invoice_due":
        return invoiceCheck(rid);
      case "membership_expiring":
      case "membership_expired":
        return memberRenewedSince(rid, task.createdAt);
      case "welcome_portal": {
        const m = await prisma.member.findUnique({ where: { id: rid }, select: { userId: true } });
        return passwordCheck(m?.userId);
      }
      case "refund_ready":
        return refundCheck(rid);
      case "order_ready":
      case "restring_ready":
        return orderCheck(rid);
      case "session_cancelled_by_club":
        return choiceCheck(await prisma.clubCancellation.findUnique({ where: { bookingId: rid }, select: { status: true, deadlineAt: true } }));
      default:
        return yes;
    }
  }
  switch (task.event) {
    case "DUES_REMINDER":
      return ids.billId ? billCheck(ids.billId) : ids.invoiceId ? invoiceCheck(ids.invoiceId) : yes;
    case "MEMBERSHIP_EXPIRY":
      return ids.membershipId ? renewedCheck(ids.membershipId) : yes;
    case "MEMBERSHIP_WELCOME":
    case "CREDENTIALS_REISSUED":
      return passwordCheck(task.userId ?? ids.userId);
    case "REFUND_READY_TO_COLLECT":
    case "REFUND_UNCLAIMED_REMINDER":
      return ids.refundId ? refundCheck(ids.refundId) : yes;
    case "CANCELLATION_CHOICE_REMINDER":
      return ids.clubCancellationId ? choiceCheck(await prisma.clubCancellation.findUnique({ where: { id: ids.clubCancellationId }, select: { status: true, deadlineAt: true } })) : yes;
    case "BOOKING_CANCELLED_BY_CLUB":
      return ids.bookingId ? choiceCheck(await prisma.clubCancellation.findUnique({ where: { bookingId: ids.bookingId }, select: { status: true, deadlineAt: true } })) : yes;
    case "ORDER_READY":
      return ids.orderId ? orderCheck(ids.orderId) : yes;
    case "RESTRING_READY":
      return ids.ticketId ? orderCheck(ids.ticketId) : yes;
    default:
      return yes;
  }
}

// ───────── SA-1 + SA-2 + SA-3 together ─────────

export type TaskVerdict =
  | { status: "OK" }
  | { status: "SKIPPED_NOT_RELEVANT" | "SKIPPED_DUPLICATE" | "EXPIRED"; reason: string };

export const MANUAL_OPEN = ["QUEUED", "LINK_OPENED"] as const;

/** The age limit (SA-3) as a cut-off: tasks created before it are expired. */
export async function expiryCutoff(now = clock.now()): Promise<{ days: number; cutoff: Date }> {
  const days = (await getSettings()).manual_message_max_age_days;
  return { days, cutoff: new Date(now.getTime() - days * 86_400_000) };
}

/**
 * Classify queued manual tasks: not relevant any more (SA-1) → duplicate of a newer task (SA-2, against every open
 * task in the queue, not only these) → too old (SA-3) → OK. Reads only; `applyVerdicts` writes.
 */
export async function classifyTasks(tasks: TaskRow[]): Promise<Map<string, TaskVerdict>> {
  const out = new Map<string, TaskVerdict>();
  if (!tasks.length) return out;
  const keys = new Map<string, string | null>();
  const { days, cutoff } = await expiryCutoff();
  // SA-2: the newest open task of each group (all open manual tasks, so a filter can't hide the newer copy).
  const open = await prisma.notificationDelivery.findMany({
    where: { channel: "WHATSAPP_MANUAL", status: { in: [...MANUAL_OPEN] } },
    select: { id: true, event: true, dedupeKey: true, userId: true, guestId: true, leadId: true, recipientKey: true, toAddress: true, createdAt: true, status: true, templateId: true, templateContext: true, recordId: true, contextIds: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const newest = new Map<string, string>();
  for (const t of open) {
    const g = groupKey(t, await contextIdsOf(t, keys));
    if (!newest.has(g)) newest.set(g, t.id);
  }
  for (const t of tasks) {
    const rel = await isStillRelevant(t, keys);
    if (!rel.relevant) {
      out.set(t.id, { status: "SKIPPED_NOT_RELEVANT", reason: rel.reason });
      continue;
    }
    const keeper = newest.get(groupKey(t, await contextIdsOf(t, keys)));
    if (keeper && keeper !== t.id) {
      out.set(t.id, { status: "SKIPPED_DUPLICATE", reason: "A newer copy of this message is in the queue" });
      continue;
    }
    if (t.createdAt.getTime() < cutoff.getTime()) {
      out.set(t.id, { status: "EXPIRED", reason: `Older than ${days} day${days === 1 ? "" : "s"}` });
      continue;
    }
    out.set(t.id, { status: "OK" });
  }
  return out;
}

/** Write the verdicts on tasks that are still QUEUED (audited once per call). Returns how many changed per status. */
export async function applyVerdicts(db: Tx | typeof prisma, actor: Actor, verdicts: Map<string, TaskVerdict>, context: { jobId?: string | null } = {}) {
  const ids: string[] = [];
  const statuses: string[] = [];
  const reasons: string[] = [];
  for (const [id, v] of verdicts) {
    if (v.status === "OK") continue;
    ids.push(id);
    statuses.push(v.status);
    reasons.push(v.reason);
  }
  const counts: Record<string, number> = {};
  if (!ids.length) return counts;
  const now = clock.now();
  const changed = await db.$queryRaw<{ id: string; status: string }[]>`
    UPDATE notification_deliveries d SET status = x.status, error = x.reason, updated_at = ${now}
      FROM unnest(${ids}::text[], ${statuses}::text[], ${reasons}::text[]) AS x(id, status, reason)
     WHERE d.id = x.id AND d.channel = 'WHATSAPP_MANUAL' AND d.status = 'QUEUED'
       AND (d.handled_by IS NULL OR d.handled_by NOT LIKE 'sendall:%')
    RETURNING d.id, d.status`;
  for (const c of changed) counts[c.status] = (counts[c.status] ?? 0) + 1;
  if (changed.length) {
    await audit(db as Tx, actor, "message.queue_cleaned", "notification_delivery", context.jobId ?? "manual-queue", {
      after: { counts, ids: changed.map((c) => c.id).slice(0, 500), jobId: context.jobId ?? null },
    });
  }
  return counts;
}

/**
 * Worker job (every 15 minutes): keep "Messages to send" clean — SA-1 not relevant, SA-2 duplicates, SA-3 expired —
 * so nobody sends a paid dues reminder by hand either.
 */
export async function cleanManualQueue(actor: Actor, limit = 2000) {
  const tasks = await prisma.notificationDelivery.findMany({
    where: { channel: "WHATSAPP_MANUAL", status: "QUEUED", OR: [{ handledBy: null }, { NOT: { handledBy: { startsWith: "sendall:" } } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit,
  });
  const verdicts = await classifyTasks(tasks);
  return applyVerdicts(prisma, actor, verdicts);
}
