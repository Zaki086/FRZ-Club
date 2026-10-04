// v5 §3.3–3.4: what composer sends and bulk sends share — rendering a template for a record, which channels a
// recipient can receive (enforced here, server-side), the duplicate guard, writing the `notification_deliveries` rows
// (MT-6: template + version, rendered text, channel, masked recipient, sent by, status) and delivering one email or
// push row. Email/push rows that wait for the messages worker carry handled_by = 'msgq:queue', so the v4 push/email
// worker (channels.ts flushDeliveries) never picks them up: their email needs the club layout of §3.2.
import type { MessageTemplate, NotificationDelivery, Prisma } from "@prisma/client";
import webpush from "web-push";
import { clock } from "@/lib/clock";
import { formatPhone } from "@/lib/validation/contact";
import { prisma, type Tx } from "../../db";
import { DomainError } from "../../errors";
import { actorId, type Actor } from "../../rbac/actor";
import { assertCan } from "../../rbac/permissions";
import { getCapabilities, type Capabilities } from "../capabilities";
import { inQuietHours, pushPayload, quietHoursEnd } from "../channels";
import { logMessage } from "../messages";
import { mailTransport } from "../notifications";
import { getSettings } from "../settings";
import { templateFor, toWhatsAppNumber, whatsappReady } from "../whatsapp/config";
import { buildTemplate } from "../whatsapp/templates";
import {
  DUPLICATE_WINDOW_HOURS, TEMPLATE_CHANNELS,
  type ChannelOption, type DeliveryChannel, type Recipient, type RenderedMessage, type TemplateCategory, type TemplateChannel, type TemplateContext, type TemplateOverrides,
} from "./contract";
import { absoluteUrl, linkFor, type LoadedRecord, type Person } from "./records";
import { buildEmail, linkLabel, pushText, type EmailClub } from "./render";
import { unsubscribePostUrl, unsubscribeUrl } from "./unsubscribe";
import { hasFillIn, isAutoWhatsAppTemplate, maskEmail, maskPhone, renderText, unknownVariables, waMeLink, type RenderValues } from "./variables";
import { renderDelivery, templateSpec } from "./manual-queue";

/** `notification_deliveries.event` of every template message. */
export const MSG_EVENT = "TEMPLATE_MESSAGE";
/** handled_by of email/push/automatic-WhatsApp rows waiting for the messages worker. */
export const QUEUE_MARK = "msgq:queue";
export const RUN_PREFIX = "msgq:run:";

export type TemplateContent = Pick<MessageTemplate, "whatsappText" | "emailSubject" | "emailBody" | "pushTitle" | "pushBody">;
export type TemplateLike = TemplateContent & Pick<MessageTemplate, "id" | "key" | "name" | "context" | "category" | "channels" | "waTemplate" | "version">;

// ───────── who may send what (MT-4 / MT-5) ─────────

/** TRANSACTIONAL: front desk, Manager, Owner. ANNOUNCEMENT: Manager and Owner only (403 for the front desk). */
export function assertCanSendCategory(actor: Actor, category: string) {
  assertCan(actor, "messages.compose");
  if (category === "ANNOUNCEMENT") assertCan(actor, "messages.announce");
}

/** A template that can be sent: exists, active, not archived. */
export async function sendableTemplate(id: string): Promise<MessageTemplate> {
  const t = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!t) throw new DomainError("NOT_FOUND", "Template was not found.");
  if (t.archivedAt || !t.active) throw new DomainError("ORDER_STATE_INVALID", `"${t.name}" is ${t.archivedAt ? "archived" : "switched off"} — choose another template.`);
  return t;
}

// ───────── club details and rendering ─────────

export type ClubInfo = EmailClub & { portalUrl: string };

export async function clubInfo(): Promise<ClubInfo> {
  const c = (await getSettings()).club;
  return {
    name: c.name.trim(),
    phone: c.phone ? formatPhone(c.phone) || c.phone : "",
    address: c.address.trim(),
    logoUrl: c.logo_url ? absoluteUrl(c.logo_url) : "",
    portalUrl: absoluteUrl("/portal"),
  };
}

export type RenderedParts = {
  /** v6 URL-3: every variable of this send and the per-send overrides — stored on each row as its render spec. */
  values?: RenderValues;
  overrides?: Record<string, string> | null;
  link: string | null;
  linkText: string;
  whatsapp: string;
  emailSubject: string;
  emailBody: string;
  pushTitle: string;
  pushBody: string;
};

/** The template's text (or the per-send overrides) with the record's values filled in. */
export function renderParts(t: TemplateLike, rec: LoadedRecord, club: ClubInfo, overrides?: TemplateOverrides): RenderedParts {
  const src = { ...pickContent(t), ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => typeof v === "string")) } as TemplateContent;
  if (overrides) {
    const unknown = unknownVariables(t.context as TemplateContext, Object.values(overrides).filter((v): v is string => typeof v === "string"));
    if (unknown.length) throw new DomainError("UNKNOWN_TEMPLATE_VARIABLE", `${unknown.join(", ")} can't be used in this message.`, { unknown, context: t.context });
  }
  const link = linkFor(rec, t.key);
  const values = { ...rec.values, "club.name": club.name, "club.phone": club.phone, "club.address": club.address, "portal.url": club.portalUrl, link: link ?? "" };
  return {
    values,
    overrides: overrides ? (Object.fromEntries(Object.entries(overrides).filter(([, v]) => typeof v === "string")) as Record<string, string>) : null,
    link,
    linkText: link ? linkLabel(link, t.key) : "",
    whatsapp: renderText(src.whatsappText, values),
    emailSubject: renderText(src.emailSubject, values).replace(/\s+/g, " "),
    emailBody: renderText(src.emailBody, values),
    pushTitle: renderText(src.pushTitle, values).replace(/\s+/g, " "),
    pushBody: renderText(src.pushBody, values),
  };
}

function pickContent(t: TemplateContent): TemplateContent {
  return { whatsappText: t.whatsappText, emailSubject: t.emailSubject, emailBody: t.emailBody, pushTitle: t.pushTitle, pushBody: t.pushBody };
}

/** Refuse to send a `[[…]]` part staff still had to write (e.g. the details of a club notice). */
export function assertFilledIn(parts: RenderedParts, channels: TemplateChannel[]) {
  const texts: string[] = [];
  if (channels.includes("WHATSAPP")) texts.push(parts.whatsapp);
  if (channels.includes("EMAIL")) texts.push(parts.emailSubject, parts.emailBody);
  if (channels.includes("PUSH")) texts.push(parts.pushTitle, parts.pushBody);
  if (texts.some(hasFillIn)) throw new DomainError("VALIDATION_FAILED", "Write the part in [[ ]] first — edit the message text for this send.", { field: "overrides" });
}

/** The recipient as the composer shows it (masked). */
export function toRecipient(p: Person, pushDevices: number): Recipient {
  return { kind: p.kind, id: p.id, name: p.name, phone: maskPhone(p.phone), email: maskEmail(p.email), pushDevices };
}

export function recipientKey(p: Person): string {
  return `${p.kind.toLowerCase()}:${p.id}`;
}

/** What the person would receive, per channel (preview). */
export function renderedMessage(parts: RenderedParts, channels: TemplateChannel[], person: Person | null, club: ClubInfo, category: string, kind: Recipient["kind"]): RenderedMessage {
  const out: RenderedMessage = {};
  if (channels.includes("WHATSAPP")) {
    const n = person ? toWhatsAppNumber(person.phone ?? "") : null;
    out.whatsapp = { text: parts.whatsapp, length: parts.whatsapp.length, waLink: n ? waMeLink(n, parts.whatsapp) : null };
  }
  if (channels.includes("EMAIL")) {
    const email = buildEmail({
      subject: parts.emailSubject, body: parts.emailBody, link: parts.link, linkLabel: parts.linkText, club, category: category as TemplateCategory, recipientKind: kind,
      unsubscribeUrl: category === "ANNOUNCEMENT" ? unsubscribeFor(person) : null,
    });
    out.email = { subject: email.subject, text: email.text, html: email.html };
  }
  if (channels.includes("PUSH")) out.push = pushText(parts.pushTitle, parts.pushBody);
  return out;
}

function unsubscribeFor(p: Person | null, post = false): string | null {
  if (!p) return null;
  const kind = p.kind === "MEMBER" ? "m" : p.kind === "LEAD" ? "l" : null;
  if (!kind) return null;
  return post ? unsubscribePostUrl(kind, p.id) : unsubscribeUrl(kind, p.id);
}

// ───────── channel availability (shown in the composer, enforced on send) ─────────

export type Availability = { options: ChannelOption[]; auto: boolean; autoReason: string | null };

export async function pushDeviceCounts(userIds: Array<string | null>): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await prisma.pushSubscription.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.userId, r._count._all]));
}

/**
 * Per channel: can this recipient get this template now? Only channels that work for the club (capabilities) AND that
 * the person can receive (address, opt-outs, a push device) AND that the template has text for. ANNOUNCEMENT emails
 * also respect the unsubscribe link; WhatsApp respects STOP / opt-out for every category.
 */
export async function availability(t: TemplateLike, rec: LoadedRecord, pushDevices: number, caps?: Capabilities): Promise<Availability> {
  const c = caps ?? (await getCapabilities());
  const p = rec.person;
  const has = new Set(t.channels);
  const why = (channel: TemplateChannel): string | null => {
    if (!has.has(channel)) return `This template has no ${channel === "WHATSAPP" ? "WhatsApp" : channel === "EMAIL" ? "email" : "push"} text`;
    if (!p) return "Nobody to message on this record";
    switch (channel) {
      case "WHATSAPP":
        if (!toWhatsAppNumber(p.phone ?? "")) return "No mobile number";
        if (p.waOptedOut) return "Opted out of WhatsApp (replied STOP)";
        if (!p.prefs.whatsapp) return "Turned off WhatsApp messages";
        return null;
      case "EMAIL":
        if (!c.email.enabled) return `Email is not set up: ${c.email.reason}`;
        if (!p.email) return "No email address";
        if (!p.prefs.email) return "Turned off email";
        if (t.category === "ANNOUNCEMENT" && p.announcementsOptOut) return "Unsubscribed from announcement emails";
        return null;
      case "PUSH":
        if (!c.push.enabled) return `Push is not set up: ${c.push.reason}`;
        if (!p.userId) return "No member login, so no app notifications";
        if (!p.prefs.push) return "Turned off push notifications";
        if (!pushDevices) return "No device has turned on notifications";
        return null;
    }
  };
  const options = TEMPLATE_CHANNELS.map((channel) => {
    const reason = why(channel);
    return { channel, available: !reason, reason };
  });
  let autoReason: string | null = null;
  if (options.find((o) => o.channel === "WHATSAPP")?.available !== true) autoReason = "WhatsApp isn't available for this person";
  else if (!t.waTemplate || !isAutoWhatsAppTemplate(t.waTemplate)) autoReason = "This template has no WhatsApp API template";
  else if (!(await whatsappReady())) autoReason = `Automatic WhatsApp is off: ${c["whatsapp.api"].reason}`;
  else {
    const mapped = await templateFor(prisma as unknown as Tx, t.waTemplate);
    if (!mapped) autoReason = `The WhatsApp template ${t.waTemplate} is not set up in Settings → WhatsApp`;
    else if (!mapped.approved) autoReason = `The WhatsApp template ${mapped.name} is not approved by Meta yet`;
    else if (!p?.waOptIn) autoReason = "Not opted in to WhatsApp updates";
    else if (!rec.wa[t.waTemplate as keyof typeof rec.wa]) autoReason = "This record can't fill the WhatsApp template";
  }
  return { options, auto: !autoReason, autoReason };
}

/** Server-side gate: every chosen channel must be available (else CHANNEL_NOT_AVAILABLE). */
export function assertChannels(av: Availability, channels: TemplateChannel[], autoWhatsApp: boolean) {
  for (const ch of channels) {
    const o = av.options.find((x) => x.channel === ch)!;
    if (!o.available) throw new DomainError("CHANNEL_NOT_AVAILABLE", `${ch === "WHATSAPP" ? "WhatsApp" : ch === "EMAIL" ? "Email" : "Push"} can't be used: ${o.reason}.`, { channel: ch, reason: o.reason });
  }
  if (autoWhatsApp && channels.includes("WHATSAPP") && !av.auto) {
    throw new DomainError("CHANNEL_NOT_AVAILABLE", `Automatic WhatsApp can't be used: ${av.autoReason}.`, { channel: "WHATSAPP", reason: av.autoReason, auto: true });
  }
}

// ───────── duplicate guard ─────────

/** The latest send of this template to these recipients within 24 h (queued, opened or sent — not skipped/failed). */
export async function recentSends(templateId: string, keys: string[]): Promise<Map<string, { at: Date; by: string | null }>> {
  if (!keys.length) return new Map();
  const since = new Date(clock.now().getTime() - DUPLICATE_WINDOW_HOURS * 3_600_000);
  const rows = await prisma.$queryRaw<{ recipient_key: string; at: Date; by: string | null }[]>`
    SELECT DISTINCT ON (recipient_key) recipient_key, created_at AS at, triggered_by AS by
      FROM notification_deliveries
     WHERE template_id = ${templateId} AND recipient_key = ANY(${keys}::text[]) AND created_at > ${since} AND status NOT IN ('SKIPPED', 'FAILED')
     ORDER BY recipient_key, created_at DESC`;
  return new Map(rows.map((r) => [r.recipient_key, { at: r.at, by: r.by }]));
}

// ───────── writing the rows ─────────

export type RowBase = {
  template: TemplateLike;
  rec: LoadedRecord;
  person: Person;
  sendId: string;
  bulkId?: string | null;
  actor: Actor;
};

export type PlannedRow = Prisma.NotificationDeliveryCreateManyInput & { id: string; channel: DeliveryChannel };

const newId = () => `nd_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;

/** The rows of one recipient's send (not yet written). `claim`: the handled_by of email/push/auto rows. */
export async function planRows(
  b: RowBase, parts: RenderedParts, channels: TemplateChannel[], opts: { autoWhatsApp: boolean; claim: string; devices?: Array<{ id: string; userAgent: string | null }> },
): Promise<PlannedRow[]> {
  const { template: t, rec, person: p } = b;
  const now = clock.now();
  // v6 URL-3: template id + version + variables + record, rendered again when the row is sent or opened.
  const autoWa = t.waTemplate ? rec.wa[t.waTemplate as keyof typeof rec.wa] ?? null : null;
  const renderSpec = parts.values && t.id !== "draft" ? templateSpec({ id: t.id, version: t.version, context: t.context, key: t.key }, rec.id, parts.values, parts.overrides, autoWa) : undefined;
  const base = {
    event: MSG_EVENT, userId: p.userId, memberId: p.memberId, guestId: p.guestId, leadId: p.leadId, triggeredBy: actorId(b.actor) ?? "system",
    templateId: t.id, templateVersion: t.version, templateContext: t.context, templateCategory: t.category, recordId: rec.id, recipientKey: recipientKey(p),
    sendId: b.sendId, bulkId: b.bulkId ?? null, link: parts.link, createdAt: now, updatedAt: now,
    ...(renderSpec ? { renderSpec: renderSpec as unknown as Prisma.InputJsonValue, contextIds: { context: t.context, recordId: rec.id, templateKey: t.key } } : {}),
  };
  const key = `msg:${b.sendId}`;
  const rows: PlannedRow[] = [];
  if (channels.includes("WHATSAPP")) {
    const number = toWhatsAppNumber(p.phone ?? "")!;
    const masked = maskPhone(number);
    const wa = opts.autoWhatsApp ? rec.wa[t.waTemplate as keyof typeof rec.wa] : undefined;
    const mapped = wa ? await templateFor(prisma as unknown as Tx, wa.template) : null;
    if (wa && mapped?.approved) {
      const built = buildTemplate(wa);
      rows.push({
        ...base, id: newId(), dedupeKey: key, channel: "WHATSAPP_API", status: "QUEUED", toAddress: number, toMasked: masked, title: t.name, body: parts.whatsapp,
        whatsappText: parts.whatsapp, waTemplate: mapped.name, waLanguage: mapped.language, waParams: built.params, waButtonParam: built.buttonParam,
        handledBy: opts.claim === QUEUE_MARK ? QUEUE_MARK : null,
      });
    } else {
      rows.push({ ...base, id: newId(), dedupeKey: key, channel: "WHATSAPP_MANUAL", status: "QUEUED", toAddress: number, toMasked: masked, title: t.name, body: parts.whatsapp, whatsappText: parts.whatsapp });
    }
  }
  if (channels.includes("EMAIL")) {
    rows.push({ ...base, id: newId(), dedupeKey: key, channel: "EMAIL", status: "QUEUED", toAddress: p.email!, toMasked: maskEmail(p.email), title: parts.emailSubject, body: parts.emailBody, handledBy: opts.claim });
  }
  if (channels.includes("PUSH")) {
    // NT-7: a push waits out the quiet hours (22:00–07:00 IST), like every non-urgent push.
    const notBefore = inQuietHours(now) ? quietHoursEnd(now) : null;
    for (const d of opts.devices ?? []) {
      rows.push({
        ...base, id: newId(), dedupeKey: `${key}:${d.id}`, channel: "PUSH", status: "QUEUED", toAddress: deviceName(d.userAgent), toMasked: deviceName(d.userAgent),
        title: parts.pushTitle, body: parts.pushBody, pushSubscriptionId: d.id, notBefore, handledBy: notBefore ? QUEUE_MARK : opts.claim,
      });
    }
  }
  return rows;
}

function deviceName(ua: string | null): string {
  const s = ua ?? "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Macintosh|Mac OS X/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /CriOS|Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

export async function writeRows(tx: Tx, rows: PlannedRow[]) {
  if (rows.length) await tx.notificationDelivery.createMany({ data: rows });
}

// ───────── delivering one row ─────────

type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
type PushSender = (sub: PushSub, payload: string, opts: { TTL: number; urgency: "high" | "normal" }) => Promise<unknown>;
let pushSenderForTests: PushSender | null = null;
const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

/** Tests only: capture template pushes instead of calling the push services. */
export function setMessagePushSenderForTests(fn: PushSender | null) {
  if (!isTest()) throw new Error("push sender override is only available in tests");
  pushSenderForTests = fn;
}

async function sendWebPush(sub: PushSub, payload: string, opts: { TTL: number; urgency: "high" | "normal" }, clubEmail: string) {
  if (pushSenderForTests) return pushSenderForTests(sub, payload, opts);
  const subject = (process.env.VAPID_SUBJECT ?? "").trim() || (clubEmail ? `mailto:${clubEmail}` : absoluteUrl("/"));
  webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return webpush.sendNotification(sub, payload, opts);
}

type MailWithHtml = { from?: string; to: string; subject: string; text: string; html: string; headers?: Record<string, string> };

const finish = (id: string, data: Prisma.NotificationDeliveryUpdateInput) => prisma.notificationDelivery.update({ where: { id }, data: { ...data, updatedAt: clock.now() } });

/** Send one queued email or push row now and record SENT / FAILED on it. */
export async function deliverRow(d: NotificationDelivery, caps?: Capabilities): Promise<"SENT" | "FAILED"> {
  const c = caps ?? (await getCapabilities());
  const attempts = d.attempts + 1;
  // v6 URL-3: subject/body/link as they read now (template + version + variables, today's APP_URL); older rows as stored.
  const now = await renderDelivery(d);
  const job = d.bulkJobId ?? null;
  try {
    if (d.channel === "EMAIL") {
      if (!c.email.enabled) throw new Error(`Email is no longer available: ${c.email.reason}`);
      if (!d.toAddress) throw new Error("No email address");
      const club = await clubInfo();
      const kind = (d.recipientKey?.split(":")[0] ?? "member").toUpperCase() as Recipient["kind"];
      const announce = d.templateCategory === "ANNOUNCEMENT";
      const key = d.templateId ? (await prisma.messageTemplate.findUnique({ where: { id: d.templateId }, select: { key: true } }))?.key ?? null : null;
      const who = { kind, id: d.memberId ?? d.leadId ?? "" } as Person;
      const email = buildEmail({
        subject: now.title, body: now.body, link: now.link, linkLabel: now.link ? linkLabel(now.link, key) : "", club, category: announce ? "ANNOUNCEMENT" : "TRANSACTIONAL",
        recipientKind: kind, unsubscribeUrl: announce ? unsubscribeFor(who) : null,
      });
      const post = announce ? unsubscribeFor(who, true) : null;
      const mail: MailWithHtml = {
        from: process.env.SMTP_FROM, to: d.toAddress, subject: email.subject, text: email.text, html: email.html,
        // RFC 8058: mail apps show their own "Unsubscribe" button and POST to it in one click.
        ...(post ? { headers: { "List-Unsubscribe": `<${post}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      };
      await mailTransport().sendMail(mail);
      await finish(d.id, { status: "SENT", sentAt: clock.now(), handledBy: null, attempts, error: null });
      await logMessage(prisma, { channel: "EMAIL", to: d.toAddress, subject: email.subject, body: email.text, status: "SENT", entity: d.templateId ? "message_template" : null, entityId: d.templateId, actorId: d.triggeredBy === "system" ? null : d.triggeredBy, jobId: job });
      return "SENT";
    }
    if (d.channel === "PUSH") {
      if (!c.push.enabled) throw new Error(`Push is no longer available: ${c.push.reason}`);
      const sub = d.pushSubscriptionId ? await prisma.pushSubscription.findUnique({ where: { id: d.pushSubscriptionId } }) : null;
      if (!sub) throw new Error("This device turned notifications off");
      const { payload, options } = pushPayload({ event: d.event, title: now.title, body: now.body, link: now.link ?? d.link, dedupeKey: d.dedupeKey });
      try {
        await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), options, (await getSettings()).club.email);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // NT-9: the browser unsubscribed or the subscription expired — forget it.
        if (code === 404 || code === 410) await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
        throw e;
      }
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: clock.now() } });
      await finish(d.id, { status: "SENT", sentAt: clock.now(), handledBy: null, attempts, error: null });
      // v6 SA-11: a push sent by a "Send all" job is in the Message Log with the job id.
      if (job) await logMessage(prisma, { channel: "PUSH", to: d.toAddress ?? "device", subject: now.title, body: now.body, status: "SENT", jobId: job });
      return "SENT";
    }
    throw new Error(`Channel ${d.channel} is not delivered here`);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    await finish(d.id, { status: "FAILED", handledBy: null, attempts, error: msg, notBefore: null });
    if (d.channel === "EMAIL" || job) {
      await logMessage(prisma, {
        channel: d.channel === "PUSH" ? "PUSH" : "EMAIL", to: d.toAddress ?? "", subject: now.title, body: now.body, status: "FAILED", error: msg,
        entity: d.templateId ? "message_template" : null, entityId: d.templateId, actorId: d.triggeredBy === "system" ? null : d.triggeredBy, jobId: job,
      });
    }
    return "FAILED";
  }
}

/** The person whose message this is (for the masked recipient in replies). */
export function contextOf(t: TemplateLike): TemplateContext {
  return t.context as TemplateContext;
}

export function channelsOf(t: TemplateLike): TemplateChannel[] {
  return t.channels as TemplateChannel[];
}
