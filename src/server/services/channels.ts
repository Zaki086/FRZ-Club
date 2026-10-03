// v3 §6.3 notification channels. `notifyMember(tx, event, recipient, payload)` puts the message in the person's
// in-app bell and fans it out to every channel they can receive *and* that really works (capabilities), recording
// every attempt in `notification_deliveries` — unavailable channels as SKIPPED with the reason, never as SENT.
// Exactly once per dedupe key + channel (NT-1). The worker sends what is QUEUED (push, email, WhatsApp API);
// manual WhatsApp messages wait in the front desk's "Messages to send" queue and are only ever marked SENT by a person.
import { createHmac, timingSafeEqual } from "node:crypto";
import webpush from "web-push";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { prisma, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { getCapabilities, invalidateCapabilities, whatsappConfigured } from "./capabilities";
import { logMessage, waNumber } from "./messages";
import { mailTransport, notify } from "./notifications";
import { getSettings, updateSetting } from "./settings";

export const CHANNELS = ["IN_APP", "PUSH", "EMAIL", "WHATSAPP_API", "WHATSAPP_MANUAL"] as const;
export type Channel = (typeof CHANNELS)[number];
export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "LINK_OPENED" | "SKIPPED";

/** Member-facing events. `params` are the WhatsApp template body parameters, in order, for the Owner's template. */
export const MEMBER_EVENTS = {
  MEMBERSHIP_WELCOME: "Welcome with login link (params: name, plan, start, end, member code, set-password link)",
  MEMBERSHIP_RENEWED: "Renewal confirmed (params: name, plan, start, end)",
  MEMBERSHIP_EXPIRY: "Membership expiring / expired (params: name, plan, end date)",
  DUES_REMINDER: "Amount due (params: name, amount, what for, days unpaid)",
  REFUND_COMPLETED: "Refund paid (params: name, amount, refund code)",
  CREDENTIALS_REISSUED: "New login link (params: name, set-password link)",
  BOOKING_CANCELLED_BY_CLUB: "Session cancelled by the club (params: name, court, date and time, reason, link)",
  BOOKING_CANCELLED: "Booking cancelled by the front desk (params: name, court, date and time, refund)",
  BOOKING_RESCHEDULED: "Cancelled booking moved to a new time (params: name, old booking, new court, new date and time)",
  BOOKING_AUTO_REFUNDED: "No choice made in time, refunded automatically (params: name, booking, amount, how)",
  REFUND_REQUESTED: "Refund asked for, waiting for approval (params: name, amount, refund code)",
  REFUND_APPROVED: "Refund approved (params: name, amount, refund code, how it is paid)",
  REFUND_REJECTED: "Refund not approved (params: name, amount, refund code, reason)",
} as const;
export type MemberEvent = keyof typeof MEMBER_EVENTS;

export type MemberMessage = {
  /** A member event (MEMBER_EVENTS) or, for staff, e.g. LEAD_ASSIGNED. */
  event: MemberEvent | "LEAD_ASSIGNED" | "LEAD_ESCALATED";
  /** Channels besides in-app (default: all). Staff messages use ["PUSH"]: no email/WhatsApp rows are written. */
  channels?: Array<Exclude<Channel, "IN_APP">>;
  userId: string;
  memberId?: string | null;
  title: string;
  body: string;
  /** Path in the app (e.g. /portal/membership) or a full URL. */
  link?: string | null;
  dedupeKey: string;
  params?: string[];
  actor?: Actor;
};

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");
export const absolute = (link: string | null | undefined) => (!link ? "" : /^https?:\/\//.test(link) ? link : `${appUrl()}${link}`);

function cuid(): string {
  return "nd_" + globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

async function insertDelivery(tx: Tx, d: { event: string; dedupeKey: string; channel: Channel; status: DeliveryStatus; userId: string | null; guestId?: string | null; memberId?: string | null; to?: string | null; title: string; body: string; link?: string | null; whatsappText?: string | null; error?: string | null; triggeredBy?: string | null }) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO notification_deliveries (id, event, dedupe_key, channel, status, user_id, guest_id, member_id, to_address, title, body, link, whatsapp_text, error, triggered_by, sent_at, updated_at)
    VALUES (${cuid()}, ${d.event}, ${d.dedupeKey}, ${d.channel}, ${d.status}, ${d.userId}, ${d.guestId ?? null}, ${d.memberId ?? null}, ${d.to ?? null}, ${d.title}, ${d.body},
            ${d.link ?? null}, ${d.whatsappText ?? null}, ${d.error ?? null}, ${d.triggeredBy ?? null}, ${d.status === "SENT" ? clock.now() : null}, now())
    ON CONFLICT (dedupe_key, channel) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

/**
 * Reach a member (or a guardian) on every channel they can receive. Returns one line per channel. Calling it again
 * with the same dedupe key changes nothing (exactly once per channel).
 */
export async function notifyMember(tx: Tx, m: MemberMessage): Promise<Array<{ channel: Channel; status: DeliveryStatus; reason?: string }>> {
  const triggeredBy = m.actor ? (m.actor.kind === "USER" ? actorId(m.actor) : "system") : "system";
  const base = { event: m.event, dedupeKey: m.dedupeKey, userId: m.userId, memberId: m.memberId ?? null, title: m.title, body: m.body, link: m.link ?? null, triggeredBy };
  // In-app first: it is the exactly-once gate for the whole fan-out.
  if (!(await insertDelivery(tx, { ...base, channel: "IN_APP", status: "SENT" }))) return [];
  await notify(tx, { userIds: [m.userId], type: m.event, title: m.title, body: m.body, link: m.link ?? null, dedupeKey: m.dedupeKey });
  const user = await tx.user.findUniqueOrThrow({ where: { id: m.userId }, select: { phone: true, email: true, notifyPush: true, notifyEmail: true, notifyWhatsapp: true } });
  const caps = await getCapabilities();
  const s = await getSettings(tx);
  const out: Array<{ channel: Channel; status: DeliveryStatus; reason?: string }> = [{ channel: "IN_APP", status: "SENT" }];
  const wanted = new Set<Channel>(m.channels ?? ["PUSH", "EMAIL", "WHATSAPP_API", "WHATSAPP_MANUAL"]);
  const record = async (channel: Channel, status: DeliveryStatus, extra: { reason?: string; to?: string | null; whatsappText?: string | null } = {}) => {
    if (!wanted.has(channel)) return;
    await insertDelivery(tx, { ...base, channel, status, error: status === "SKIPPED" ? extra.reason ?? null : null, to: extra.to ?? null, whatsappText: extra.whatsappText ?? null });
    out.push({ channel, status, reason: extra.reason });
  };

  // Web Push
  const subs = caps.push.enabled ? await tx.pushSubscription.count({ where: { userId: m.userId } }) : 0;
  if (!caps.push.enabled) await record("PUSH", "SKIPPED", { reason: `Push not available: ${caps.push.reason}` });
  else if (!user.notifyPush) await record("PUSH", "SKIPPED", { reason: "Turned off by the member" });
  else if (!subs) await record("PUSH", "SKIPPED", { reason: "No device has turned on notifications" });
  else await record("PUSH", "QUEUED");

  // Email
  if (!caps.email.enabled) await record("EMAIL", "SKIPPED", { reason: `Email not available: ${caps.email.reason}` });
  else if (!user.email) await record("EMAIL", "SKIPPED", { reason: "No email address" });
  else if (!user.notifyEmail) await record("EMAIL", "SKIPPED", { reason: "Turned off by the member" });
  else await record("EMAIL", "QUEUED", { to: user.email });

  // WhatsApp: the Cloud API when it is set up and this event has an approved template; otherwise a manual task.
  const number = waNumber(user.phone);
  const text = [m.title, m.body, absolute(m.link)].filter(Boolean).join("\n");
  const template = s.whatsapp_templates[m.event];
  if (!number) {
    await record("WHATSAPP_API", "SKIPPED", { reason: "No mobile number" });
    await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "No mobile number" });
  } else if (!user.notifyWhatsapp) {
    await record("WHATSAPP_API", "SKIPPED", { reason: "Turned off by the member" });
    await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "Turned off by the member" });
  } else if (caps["whatsapp.api"].enabled && template) {
    await record("WHATSAPP_API", "QUEUED", { to: number, whatsappText: JSON.stringify({ template, params: m.params ?? [] }) });
    await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "Sent automatically by the WhatsApp API" });
  } else {
    await record("WHATSAPP_API", "SKIPPED", { reason: caps["whatsapp.api"].enabled ? "No approved template for this message" : `WhatsApp API not available: ${caps["whatsapp.api"].reason}` });
    await record("WHATSAPP_MANUAL", "QUEUED", { to: number, whatsappText: text });
  }
  return out;
}

/**
 * Who to tell about something that happened to these members: each member with a login, plus the guardian of a
 * Junior (completion pass P1) — every row keeps the member it is about.
 */
export async function memberAudience(tx: Tx, memberIds: Array<string | null | undefined>): Promise<Array<{ memberId: string; userId: string }>> {
  const ids = [...new Set(memberIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const members = await tx.member.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, guardianMemberId: true } });
  const guardians = await tx.member.findMany({ where: { id: { in: members.map((m) => m.guardianMemberId).filter((x): x is string => !!x) } }, select: { id: true, userId: true } });
  const out: Array<{ memberId: string; userId: string }> = [];
  for (const id of ids) {
    const m = members.find((x) => x.id === id);
    if (!m) continue;
    const g = m.guardianMemberId ? guardians.find((x) => x.id === m.guardianMemberId) : null;
    for (const userId of [m.userId, g?.userId]) if (userId && !out.some((o) => o.memberId === id && o.userId === userId)) out.push({ memberId: id, userId });
  }
  return out;
}

/**
 * CC-3: a guest (walk-in, trial) has no login, so no bell and no push: they are reached by email when they left an
 * address and on their phone — WhatsApp API when set up with a template for the event, else a manual WhatsApp task for
 * the desk. Only channels with an address get a row. Exactly once per dedupe key + channel. Returns the channels used.
 */
export async function notifyGuest(tx: Tx, g: { event: MemberEvent; guestId: string; title: string; body: string; dedupeKey: string; link?: string | null; params?: string[]; actor?: Actor }) {
  const guest = await tx.guest.findUnique({ where: { id: g.guestId }, select: { phone: true, email: true } });
  if (!guest) return [];
  const caps = await getCapabilities();
  const s = await getSettings(tx);
  const base = { event: g.event, dedupeKey: g.dedupeKey, userId: null, guestId: g.guestId, title: g.title, body: g.body, link: g.link ?? null, triggeredBy: g.actor?.kind === "USER" ? actorId(g.actor) : "system" };
  const out: Array<{ channel: Channel; status: DeliveryStatus }> = [];
  const put = async (channel: Channel, status: DeliveryStatus, extra: { to?: string | null; error?: string | null; whatsappText?: string | null } = {}) => {
    if (await insertDelivery(tx, { ...base, channel, status, to: extra.to ?? null, error: extra.error ?? null, whatsappText: extra.whatsappText ?? null })) out.push({ channel, status });
  };
  if (guest.email) {
    if (caps.email.enabled) await put("EMAIL", "QUEUED", { to: guest.email });
    else await put("EMAIL", "SKIPPED", { error: `Email not available: ${caps.email.reason}` });
  }
  const number = guest.phone ? waNumber(guest.phone) : null;
  if (number) {
    const template = s.whatsapp_templates[g.event];
    if (caps["whatsapp.api"].enabled && template) {
      await put("WHATSAPP_API", "QUEUED", { to: number, whatsappText: JSON.stringify({ template, params: g.params ?? [] }) });
    } else {
      await put("WHATSAPP_MANUAL", "QUEUED", { to: number, whatsappText: [g.title, g.body, absolute(g.link)].filter(Boolean).join("\n") });
    }
  }
  return out;
}

// ───────── worker: send what is queued ─────────

let pushSender: ((sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>) | null = null;
let fetcher: typeof fetch | null = null;
const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;
/** Tests only: replace the web-push sender and the HTTP client used for the WhatsApp API. */
export function setChannelTransportsForTests(t: { push?: typeof pushSender; fetch?: typeof fetch | null }) {
  if (!isTest()) throw new Error("channel transport overrides are only available in tests");
  if ("push" in t) pushSender = t.push ?? null;
  if ("fetch" in t) fetcher = t.fetch ?? null;
}

function sendPush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) {
  if (pushSender) return pushSender(sub, payload);
  // The push service's contact: VAPID_SUBJECT if set, else the club's HTTPS address (push only runs on HTTPS).
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? appUrl(), process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return webpush.sendNotification(sub, payload, { TTL: 24 * 3600 });
}

async function whatsappApi(path: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown>; status: number }> {
  const f = fetcher ?? fetch;
  const res = await f(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json, status: res.status };
}

async function sendTemplate(to: string, template: { name: string; language: string }, params: string[]) {
  const r = await whatsappApi("messages", {
    messaging_product: "whatsapp", to, type: "template",
    template: { name: template.name, language: { code: template.language }, components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p.slice(0, 1000) })) }] : [] },
  });
  if (!r.ok) {
    const err = (r.json.error as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`;
    throw Object.assign(new Error(`WhatsApp API: ${err}`), { statusCode: r.status });
  }
  return ((r.json.messages as Array<{ id: string }> | undefined)?.[0]?.id ?? null) as string | null;
}

const done = (id: string, data: Record<string, unknown>) => prisma.notificationDelivery.update({ where: { id }, data });

/** A failure that another try can't fix (no device left, mailbox refused, capability gone, bad request). */
class PermanentFailure extends Error {}

/** Tries per message, and the wait after the 1st, 2nd and 3rd failed try (the worker flushes every minute). */
export const DELIVERY_MAX_ATTEMPTS = 4;
export const DELIVERY_RETRY_MINUTES = [0, 5, 30, 120] as const;
const ATTEMPT_RE = /^Attempt (\d+) of \d+ failed/;
const STALE_SENDING_MS = 10 * 60_000;
/** While a run sends a row it holds it in `handled_by` ("worker:…"; only manual WhatsApp rows name a person there). */
const CLAIM = "worker:";

const attemptsSoFar = (error: string | null) => Number((error && ATTEMPT_RE.exec(error)?.[1]) ?? 0);

function isPermanent(channel: string, e: unknown): boolean {
  if (e instanceof PermanentFailure) return true;
  const x = e as { statusCode?: number; responseCode?: number; code?: string; message?: string };
  // Push service / WhatsApp API: 4xx means the request itself is wrong (gone, unauthorised, too big) — except 429.
  if (channel === "PUSH" || channel === "WHATSAPP_API") return typeof x.statusCode === "number" && x.statusCode >= 400 && x.statusCode < 500 && x.statusCode !== 429;
  // SMTP: 5xx is a hard bounce (no such mailbox, rejected); 4xx and network errors are worth another try.
  if (typeof x.responseCode === "number") return x.responseCode >= 500;
  if (x.code === "EENVELOPE") return true;
  return /^5\d\d\b/.test(x.message ?? "");
}

/** The email a member or guest receives: greeting, what happened, the link, and who sent it. */
async function emailText(d: { body: string; link: string | null; userId: string | null; guestId: string | null }, club: { name: string; phone: string }) {
  const who = d.userId
    ? await prisma.user.findUnique({ where: { id: d.userId }, select: { name: true, role: true } })
    : d.guestId ? await prisma.guest.findUnique({ where: { id: d.guestId }, select: { name: true } }).then((g) => (g ? { ...g, role: null } : null)) : null;
  const first = who?.name.trim().split(/\s+/)[0];
  const link = absolute(d.link);
  return [
    first ? `Hi ${first},` : "Hello,",
    d.body,
    link ? `${who?.role === "MEMBER" ? "Open in the member portal" : "Details"}: ${link}` : "",
    [club.name || "The club", club.phone].filter(Boolean).join(" · "),
    who?.role === "MEMBER" && appUrl() ? `To change how the club reaches you: ${appUrl()}/portal/notifications` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * Worker job (every minute, and in the 5-minute batch): deliver queued push, email and WhatsApp API messages and record
 * every outcome on the delivery row. Each row is claimed before it is sent, so two runs never send it twice.
 * A failure that may pass (timeout, SMTP 4xx, push service 5xx/429) is retried after 5 min, 30 min and 2 h — the row
 * stays "To send" with "Attempt n of 4 failed…" — then FAILED; a permanent one is FAILED at once. Email and WhatsApp
 * failures also go to the message log, every attempt.
 */
export async function flushDeliveries(limit = 100) {
  const now = clock.now();
  // A run that died mid-send leaves its claim on the row: after 10 minutes the row is free again.
  await prisma.notificationDelivery.updateMany({ where: { status: "QUEUED", handledBy: { startsWith: CLAIM }, updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } }, data: { handledBy: null, updatedAt: now } });
  const retryDue = (n: number) => ({ error: { startsWith: `Attempt ${n} of ` }, updatedAt: { lte: new Date(now.getTime() - DELIVERY_RETRY_MINUTES[n] * 60_000) } });
  const queued = await prisma.notificationDelivery.findMany({
    where: { status: "QUEUED", channel: { in: ["PUSH", "EMAIL", "WHATSAPP_API"] }, handledBy: null, OR: [{ error: null }, ...[1, 2, 3].map(retryDue)] },
    orderBy: { createdAt: "asc" }, take: limit,
  });
  if (!queued.length) return { sent: 0, failed: 0 };
  const caps = await getCapabilities();
  const club = (await getSettings()).club;
  const result = { sent: 0, failed: 0 };
  const run = `${CLAIM}${globalThis.crypto.randomUUID().slice(0, 8)}`;
  for (const d of queued) {
    const claimed = await prisma.notificationDelivery.updateMany({ where: { id: d.id, status: "QUEUED", handledBy: null }, data: { handledBy: run, updatedAt: clock.now() } });
    if (!claimed.count) continue; // another run has it
    const before = attemptsSoFar(d.error);
    const note = before ? `Sent on attempt ${before + 1} (before: ${d.error!.replace(ATTEMPT_RE, "").replace(/^[^:]*:\s*/, "")})`.slice(0, 500) : null;
    try {
      if (d.channel === "PUSH") {
        if (!caps.push.enabled) throw new PermanentFailure(`Push no longer available: ${caps.push.reason}`);
        const subs = await prisma.pushSubscription.findMany({ where: { userId: d.userId ?? "" } });
        if (!subs.length) throw new PermanentFailure("No device has turned on notifications");
        let ok = 0;
        let lastError: unknown = null;
        let transient = false;
        const payload = JSON.stringify({ title: d.title, body: d.body.length > 180 ? `${d.body.slice(0, 177)}…` : d.body, url: d.link ?? "/" });
        for (const sub of subs) {
          try {
            await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
            await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: clock.now() } });
            ok++;
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            lastError = e;
            if (!isPermanent("PUSH", e)) transient = true;
            // The browser unsubscribed or the subscription expired: forget it.
            if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: sub.id } });
          }
        }
        if (!ok) {
          const msg = lastError instanceof Error ? lastError.message : String(lastError);
          throw transient ? new Error(msg) : new PermanentFailure(msg);
        }
        await done(d.id, { status: "SENT", sentAt: clock.now(), error: note, handledBy: null });
      } else if (d.channel === "EMAIL") {
        if (!caps.email.enabled) throw new PermanentFailure(`Email no longer available: ${caps.email.reason}`);
        if (!d.toAddress) throw new PermanentFailure("No email address");
        await mailTransport().sendMail({ from: process.env.SMTP_FROM, to: d.toAddress, subject: d.title, text: await emailText(d, club) });
        await done(d.id, { status: "SENT", sentAt: clock.now(), error: note, handledBy: null });
        await logMessage(prisma, { channel: "EMAIL", to: d.toAddress, subject: d.title, body: d.body, status: "SENT" });
      } else {
        if (!caps["whatsapp.api"].enabled) throw new PermanentFailure(`WhatsApp API no longer available: ${caps["whatsapp.api"].reason}`);
        const spec = JSON.parse(d.whatsappText ?? "{}") as { template: { name: string; language: string }; params: string[] };
        const providerId = await sendTemplate(d.toAddress!, spec.template, spec.params ?? []);
        await done(d.id, { status: "SENT", sentAt: clock.now(), providerId, error: note, handledBy: null });
        await logMessage(prisma, { channel: "WHATSAPP", to: d.toAddress!, subject: d.title, body: d.body, status: "SENT" });
      }
      result.sent++;
    } catch (e) {
      result.failed++;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      const attempt = before + 1;
      const final = isPermanent(d.channel, e) || attempt >= DELIVERY_MAX_ATTEMPTS;
      const error = final
        ? attempt > 1 ? `${msg} (gave up after ${attempt} attempts)` : msg
        : `Attempt ${attempt} of ${DELIVERY_MAX_ATTEMPTS} failed, trying again in ${DELIVERY_RETRY_MINUTES[attempt]} min: ${msg}`;
      await done(d.id, { status: final ? "FAILED" : "QUEUED", error: error.slice(0, 500), updatedAt: clock.now(), handledBy: null });
      if (d.channel !== "PUSH") {
        await logMessage(prisma, { channel: d.channel === "EMAIL" ? "EMAIL" : "WHATSAPP", to: d.toAddress ?? "", subject: d.title, body: d.body, status: "FAILED", error: final ? msg : `${msg} — will try again` });
      }
      if (!isTest()) console.error(`[deliveries] ${d.channel} ${d.event} to ${d.toAddress ?? d.userId ?? "?"} ${final ? "FAILED" : `attempt ${attempt} failed`}: ${msg}`);
    }
  }
  return result;
}

// ───────── WhatsApp Cloud API: delivery webhook, test message ─────────

/** Meta's webhook verification handshake (GET). */
export function verifyWhatsappWebhook(params: URLSearchParams): string {
  if (params.get("hub.mode") === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && params.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return params.get("hub.challenge") ?? "";
  }
  throw new DomainError("FORBIDDEN", "Webhook verification failed.");
}

/** Delivery statuses (POST), signed with the app secret in X-Hub-Signature-256. */
export async function handleWhatsappWebhook(rawBody: string, signature: string | null) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signature?.startsWith("sha256=")) throw new DomainError("FORBIDDEN", "Missing or invalid signature.");
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(signature.slice(7));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new DomainError("FORBIDDEN", "Missing or invalid signature.");
  const body = JSON.parse(rawBody) as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string; errors?: Array<{ title?: string; message?: string }> }> } }> }> };
  let updated = 0;
  for (const e of body.entry ?? []) {
    for (const c of e.changes ?? []) {
      for (const st of c.value?.statuses ?? []) {
        const d = await prisma.notificationDelivery.findFirst({ where: { providerId: st.id, channel: "WHATSAPP_API" } });
        if (!d) continue;
        if (st.status === "delivered" || st.status === "read") {
          if (d.status !== "DELIVERED") await done(d.id, { status: "DELIVERED", deliveredAt: clock.now() });
        } else if (st.status === "failed") {
          await done(d.id, { status: "FAILED", error: (st.errors?.[0]?.message ?? st.errors?.[0]?.title ?? "failed").slice(0, 500) });
        } else continue;
        updated++;
      }
    }
  }
  return { updated };
}

export const whatsappTestSchema = z.object({ to: z.string().trim().min(10).max(15), template: z.string().trim().min(1).max(100).default("hello_world"), language: z.string().trim().min(2).max(10).default("en_US") });

/** Settings: send one template message to the Owner's phone; success switches the capability on. */
export async function sendWhatsappTest(actor: Actor, raw: z.input<typeof whatsappTestSchema>) {
  assertCan(actor, "settings");
  const input = whatsappTestSchema.parse(raw);
  const cfg = whatsappConfigured();
  if (!cfg.ok) throw new DomainError("CAPABILITY_DISABLED", `WhatsApp API is not configured: ${cfg.reason}.`);
  const to = waNumber(input.to);
  if (!to) throw new DomainError("VALIDATION_FAILED", "Enter a 10-digit Indian mobile number.");
  try {
    await sendTemplate(to, { name: input.template, language: input.language }, []);
  } catch (e) {
    throw new DomainError("VALIDATION_FAILED", e instanceof Error ? e.message : String(e));
  }
  await updateSetting(actor, "whatsapp_verified_at", clock.now().toISOString());
  invalidateCapabilities();
  return { ok: true, to };
}

// ───────── manual WhatsApp: "Messages to send" ─────────

async function manualRow(id: string) {
  const d = await prisma.notificationDelivery.findUnique({ where: { id } });
  if (!d || d.channel !== "WHATSAPP_MANUAL") throw new DomainError("NOT_FOUND", "Message was not found.");
  return d;
}

/** One click: the wa.me link with the prepared text. Recorded as LINK_OPENED — never as delivered. */
export async function openManualMessage(actor: Actor, id: string) {
  assertCan(actor, "messages.send");
  const d = await manualRow(id);
  if (d.status === "SKIPPED") throw new DomainError("ORDER_STATE_INVALID", "This message does not need to be sent by hand.");
  if (d.status === "QUEUED") await done(d.id, { status: "LINK_OPENED", openedAt: clock.now(), handledBy: actorId(actor) });
  await logMessage(prisma, { channel: "WHATSAPP", to: d.toAddress ?? "", subject: d.title, body: d.whatsappText ?? d.body, status: "OPENED", actorId: actorId(actor) });
  return { url: `https://wa.me/${d.toAddress}?text=${encodeURIComponent(d.whatsappText ?? d.body)}` };
}

/** Staff confirm they sent it from the club phone. */
export async function markManualSent(actor: Actor, id: string) {
  assertCan(actor, "messages.send");
  const d = await manualRow(id);
  if (!["QUEUED", "LINK_OPENED"].includes(d.status)) throw new DomainError("ORDER_STATE_INVALID", `This message is already ${d.status.toLowerCase().replace("_", " ")}.`);
  await done(d.id, { status: "SENT", sentAt: clock.now(), handledBy: actorId(actor) });
  await prisma.$transaction(async (tx) => audit(tx, actor, "message.manual_sent", "notification_delivery", d.id, { after: { channel: "WHATSAPP_MANUAL", to: d.toAddress } }));
  return { id: d.id, status: "SENT" };
}

// ───────── member preferences and push subscriptions ─────────

export const preferencesSchema = z.object({ push: z.boolean().optional(), email: z.boolean().optional(), whatsapp: z.boolean().optional() });

function userOf(actor: Actor): string {
  if (actor.kind !== "USER") throw new DomainError("UNAUTHENTICATED", "Please log in.");
  return actor.userId;
}

export async function myNotificationSettings(actor: Actor) {
  const userId = userOf(actor);
  const [u, devices, caps] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyPush: true, notifyEmail: true, notifyWhatsapp: true, email: true, phone: true } }),
    prisma.pushSubscription.count({ where: { userId } }),
    getCapabilities(),
  ]);
  return {
    inApp: true,
    push: { on: u.notifyPush, available: caps.push.enabled, devices },
    email: { on: u.notifyEmail, available: caps.email.enabled, address: u.email },
    whatsapp: { on: u.notifyWhatsapp, automatic: caps["whatsapp.api"].enabled, phone: u.phone },
  };
}

export async function setMyPreferences(actor: Actor, raw: z.infer<typeof preferencesSchema>) {
  const userId = userOf(actor);
  const p = preferencesSchema.parse(raw);
  await prisma.user.update({ where: { id: userId }, data: { notifyPush: p.push, notifyEmail: p.email, notifyWhatsapp: p.whatsapp } });
  return myNotificationSettings(actor);
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  userAgent: z.string().max(300).optional(),
});

export async function subscribePush(actor: Actor, raw: z.infer<typeof pushSubscriptionSchema>) {
  const userId = userOf(actor);
  const caps = await getCapabilities();
  if (!caps.push.enabled) throw new DomainError("CAPABILITY_DISABLED", "Push notifications are not set up for this club.");
  const s = pushSubscriptionSchema.parse(raw);
  await prisma.pushSubscription.upsert({
    where: { endpoint: s.endpoint },
    create: { userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: s.userAgent ?? null },
    update: { userId, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: s.userAgent ?? null },
  });
  return myNotificationSettings(actor);
}

export async function unsubscribePush(actor: Actor, endpoint: string) {
  const userId = userOf(actor);
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return myNotificationSettings(actor);
}
