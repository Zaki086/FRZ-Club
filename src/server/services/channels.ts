// v3 §6.3 / v4 §4–§5.4 notification channels. `notifyMember(tx, message)` puts the message in the person's in-app bell
// and fans it out to the channels its event uses (the v4 §4.1 catalogue below) that the person can receive *and*
// that really work (capabilities), recording every attempt in `notification_deliveries` — unavailable channels as
// SKIPPED with the reason, never as SENT. Exactly once per dedupe key + channel (NT-1).
//
// Sending happens after the business transaction commits:
// - Web Push and email: the worker (`flushDeliveries`, every minute). Non-urgent pushes wait out the quiet hours
//   (22:00–07:00 IST, NT-7); a failure that may pass is retried with backoff.
// - WhatsApp Cloud API (§5.4): the transaction writes the row QUEUED with the approved template and its parameters;
//   after commit `dispatchWhatsApp(ids)` sends it at once, and the worker sweeps QUEUED rows every 30 s. Retries back
//   off 30 s → 2 min → 10 min → 30 min → 2 h (at most 5 retries); a permanent error fails at once; a rate limit
//   pauses all WhatsApp sending and keeps the rows QUEUED. A failed or impossible automatic message becomes a manual
//   task in "Messages to send" with the same text (fallback, WA-53) — the other channels go out as usual.
// - Manual WhatsApp (WHATSAPP_MANUAL) waits in the front desk's "Messages to send" queue and is only ever marked SENT
//   by a person. Channel names stay WHATSAPP_API (automatic) and WHATSAPP_MANUAL (by hand).
import { createHash } from "node:crypto";
import { Prisma, type NotificationDelivery } from "@prisma/client";
import webpush from "web-push";
import { z } from "zod";
import { formatPhone, mobilePhone } from "@/lib/validation/contact"; // v5 CV-1 (WhatsApp test number), CV-3 display
import { parseOrValidation } from "./contacts";
import { clock } from "@/lib/clock";
import { addDays, HOUR, istDate, istParts, istToUtc } from "@/lib/time";
import { afterCommit, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { getCapabilities, invalidateCapabilities, whatsappConfigured } from "./capabilities";
import { logMessage } from "./messages";
import { mailTransport, notify } from "./notifications";
import { getSettings, updateSetting } from "./settings";
import { sendTemplateMessage, setWhatsAppFetchForTests } from "./whatsapp/client";
import { templateFor, toWhatsAppNumber, whatsappOptedIn, whatsappReady } from "./whatsapp/config";
import { buildTemplate, type WaMessage, type WaTemplateName } from "./whatsapp/templates";

export const CHANNELS = ["IN_APP", "PUSH", "EMAIL", "WHATSAPP_API", "WHATSAPP_MANUAL"] as const;
export type Channel = (typeof CHANNELS)[number];
export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "LINK_OPENED" | "SKIPPED";
type OutChannel = Exclude<Channel, "IN_APP">;

/** Member-facing events. `params` are the v3 manual-template parameters; v4 WhatsApp API messages use `wa`. */
export const MEMBER_EVENTS = {
  MEMBERSHIP_WELCOME: "Welcome with login link (params: name, plan, start, end, member code, set-password link)",
  MEMBERSHIP_RENEWED: "Renewal confirmed (params: name, plan, start, end)",
  MEMBERSHIP_EXPIRY: "Membership expiring / expired (params: name, plan, end date)",
  DUES_REMINDER: "Amount due (params: name, amount, what for, days unpaid)",
  REFUND_COMPLETED: "Refund paid (params: name, amount, refund code)",
  CREDENTIALS_REISSUED: "New login link (params: name, set-password link)",
  BOOKING_CANCELLED_BY_CLUB: "Session cancelled by the club (params: name, court, date and time, reason, link)",
  BOOKING_CANCELLED: "Booking cancelled by the member or the front desk (params: name, court, date and time, refund)",
  BOOKING_RESCHEDULED: "Cancelled booking moved to a new time (params: name, old booking, new court, new date and time)",
  BOOKING_AUTO_REFUNDED: "No choice made in time, refunded automatically (params: name, booking, amount, how)",
  REFUND_REQUESTED: "Refund asked for, waiting for approval (params: name, amount, refund code)",
  REFUND_APPROVED: "Refund approved (params: name, amount, refund code, how it is paid)",
  REFUND_REJECTED: "Refund not approved (params: name, amount, refund code, reason)",
  REFUND_READY_TO_COLLECT: "Refund approved and waiting in cash at the front desk (params: name, amount, refund code)",
  REFUND_COLLECTED: "Refund collected at the desk (params: name, amount, date, refund code)",
  REFUND_UNCLAIMED_REMINDER: "Refund still waiting at the front desk (params: name, amount, refund code)",
  // v4 §4.1 (PUSH)
  BOOKING_CONFIRMED: "Court booking confirmed (to every member player)",
  BOOKING_PLAYER_ADDED: "You were added to a booking",
  SESSION_REMINDER: "Court session starts in 2 hours",
  SOCIAL_SESSION_REMINDER: "Social play starts in 2 hours",
  CANCELLATION_CHOICE_REMINDER: "Club-cancelled session: reschedule or refund still to choose (day 3 and day 6)",
  ORDER_READY: "Shop order ready to collect",
  RESTRING_READY: "Restrung racket ready to collect",
  // v5 §1.3 MO-9 (ORDER): member bar orders from "Bar & Café" (in-app + push).
  BAR_ORDER_ACCEPTED: "Bar order accepted and sent to the kitchen",
  BAR_ORDER_REJECTED: "Bar order not accepted (with the reason)",
  BAR_ORDER_READY: "Bar order ready (\"Your order is ready\")",
  BAR_TAB_SETTLED: "Bar tab settled — receipt",
} as const;
export type MemberEvent = keyof typeof MEMBER_EVENTS;
/** Staff-facing events (in-app + push only, v4 §4.1). */
export type StaffEvent = "LEAD_ASSIGNED" | "LEAD_ESCALATED" | "REFUND_APPROVAL_NEEDED" | "DRAWER_VARIANCE" | "LEAVE_DECIDED";
export type NotifyEvent = MemberEvent | StaffEvent;

export type MemberMessage = {
  /** A member event (MEMBER_EVENTS) or, for staff, e.g. LEAD_ASSIGNED. */
  event: NotifyEvent;
  /** Channels besides in-app (default: the event's catalogue channels; never more than those). Staff messages use
   *  ["PUSH"]: no email/WhatsApp rows are written. */
  channels?: Array<OutChannel>;
  userId: string;
  memberId?: string | null;
  title: string;
  body: string;
  /** Path in the app (e.g. /portal/membership) or a full URL. */
  link?: string | null;
  dedupeKey: string;
  params?: string[];
  /** v4 §5: the WhatsApp Cloud API template for this event and its typed values (see whatsapp/templates.ts). */
  wa?: WaMessage;
  /** v4 §4.2: send the push even in the quiet hours (default: from the event, see `pushIsUrgent`). */
  urgent?: boolean;
  /** v4 §4.2: when the session this message is about starts (a club cancellation of a session today is urgent). */
  sessionAt?: Date | null;
  actor?: Actor;
};

// ───────── v4 §4.1 event catalogue (NT-5) ─────────

const ALL: OutChannel[] = ["PUSH", "EMAIL", "WHATSAPP_API", "WHATSAPP_MANUAL"];
const NO_WA: OutChannel[] = ["PUSH", "EMAIL"];
const PUSH_ONLY: OutChannel[] = ["PUSH"];

export type CatalogueRow = {
  /** Channels besides in-app (in-app is always on). */
  channels: OutChannel[];
  /** Automatic WhatsApp: "required" templates (§5.2), "optional" ones, or none (no WhatsApp at all). */
  whatsapp: { template: WaTemplateName | null; use: "required" | "optional" } | null;
  /** Web Push `Urgency` header: high for club cancellations and same-day reminders. */
  urgency: "high" | "normal";
  /** How the dedupe key is built (one message per event + recipient + channel). */
  dedupe: string;
};

/** NT-5: every event, the channels it uses and its dedupe key. In-app is always on; preferences still apply. */
export const EVENT_CATALOGUE: Record<NotifyEvent, CatalogueRow> = {
  MEMBERSHIP_WELCOME: { channels: ALL, whatsapp: { template: "membership_welcome", use: "optional" }, urgency: "normal", dedupe: "membership-welcome:<membershipId>" },
  MEMBERSHIP_RENEWED: { channels: ALL, whatsapp: { template: null, use: "optional" }, urgency: "normal", dedupe: "membership-paid:<membershipId>" },
  CREDENTIALS_REISSUED: { channels: ALL, whatsapp: { template: null, use: "optional" }, urgency: "normal", dedupe: "credentials:<userId>:<n>" },
  MEMBERSHIP_EXPIRY: { channels: ALL, whatsapp: { template: "membership_expiring", use: "optional" }, urgency: "normal", dedupe: "membership-reminder:<membershipId>:<D7|D1|EXPIRED>:<userId>" },
  DUES_REMINDER: { channels: ALL, whatsapp: { template: "dues_reminder", use: "optional" }, urgency: "normal", dedupe: "dues:<billId>:<seq> · invoice-due:<invoiceId>:<step>" },
  BOOKING_CONFIRMED: { channels: NO_WA, whatsapp: null, urgency: "normal", dedupe: "booking-confirmed:<bookingId>:<userId>" },
  BOOKING_PLAYER_ADDED: { channels: NO_WA, whatsapp: null, urgency: "normal", dedupe: "booking-player-added:<bookingId>:<memberId>:<userId>" },
  SESSION_REMINDER: { channels: PUSH_ONLY, whatsapp: null, urgency: "high", dedupe: "session-reminder:<bookingId>:<memberId>:<userId>" },
  BOOKING_CANCELLED: { channels: ALL, whatsapp: { template: "booking_cancelled_refund", use: "required" }, urgency: "normal", dedupe: "booking-cancelled:<bookingId>:<memberId>:<userId>" },
  BOOKING_CANCELLED_BY_CLUB: { channels: ALL, whatsapp: { template: "club_session_cancelled", use: "required" }, urgency: "high", dedupe: "club-cancel:<bookingId>:<memberId> · club-cancel-social:<participantId>" },
  BOOKING_RESCHEDULED: { channels: ALL, whatsapp: { template: "booking_rescheduled", use: "required" }, urgency: "normal", dedupe: "club-reschedule:<clubCancellationId>:<memberId>:<userId>" },
  BOOKING_AUTO_REFUNDED: { channels: ALL, whatsapp: { template: "booking_cancelled_refund", use: "required" }, urgency: "normal", dedupe: "club-auto-refund:<clubCancellationId>" },
  CANCELLATION_CHOICE_REMINDER: { channels: ALL, whatsapp: { template: "cancellation_choice_reminder", use: "required" }, urgency: "normal", dedupe: "choice-reminder:<clubCancellationId>:<D3|D6>:<userId>" },
  REFUND_REQUESTED: { channels: ALL, whatsapp: { template: null, use: "required" }, urgency: "normal", dedupe: "refund-requested:<refundId>" },
  REFUND_APPROVED: { channels: ALL, whatsapp: { template: "refund_ready_to_collect", use: "required" }, urgency: "normal", dedupe: "refund-approved:<refundId>" },
  REFUND_READY_TO_COLLECT: { channels: ALL, whatsapp: { template: "refund_ready_to_collect", use: "required" }, urgency: "normal", dedupe: "refund-ready:<refundId>" },
  REFUND_REJECTED: { channels: ALL, whatsapp: { template: "refund_rejected", use: "required" }, urgency: "normal", dedupe: "refund-rejected:<refundId>" },
  REFUND_COMPLETED: { channels: ALL, whatsapp: { template: "refund_completed", use: "required" }, urgency: "normal", dedupe: "refund-completed:<refundId>" },
  REFUND_COLLECTED: { channels: ALL, whatsapp: { template: "refund_completed", use: "required" }, urgency: "normal", dedupe: "refund-collected:<refundId>" },
  REFUND_UNCLAIMED_REMINDER: { channels: ALL, whatsapp: { template: "refund_unclaimed_reminder", use: "required" }, urgency: "normal", dedupe: "refund-unclaimed:<refundId>:<n>" },
  ORDER_READY: { channels: NO_WA, whatsapp: null, urgency: "normal", dedupe: "order-status:<orderId>:READY_FOR_PICKUP:<userId>" },
  RESTRING_READY: { channels: NO_WA, whatsapp: null, urgency: "normal", dedupe: "restring-ready:<ticketId>:<userId>" },
  SOCIAL_SESSION_REMINDER: { channels: PUSH_ONLY, whatsapp: null, urgency: "high", dedupe: "social-reminder:<sessionId>:<memberId>:<userId>" },
  LEAD_ASSIGNED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "lead-assigned:<leadId>:<n>" },
  LEAD_ESCALATED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "lead-escalated:<leadId>:<userId>" },
  REFUND_APPROVAL_NEEDED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "refund-approval:<refundId>:<userId>" },
  DRAWER_VARIANCE: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "drawer-variance:<sessionId>:<userId>" },
  LEAVE_DECIDED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "leave-decided:<leaveId>" },
  // v5 MO-9 (ORDER): the member is at the club, so these pushes are sent with `urgent: true` (never held for the
  // quiet hours) while the catalogue urgency header stays normal.
  BAR_ORDER_ACCEPTED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "bar-order-accepted:<memberOrderId>:<userId>" },
  BAR_ORDER_REJECTED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "bar-order-rejected:<memberOrderId>:<userId>" },
  BAR_ORDER_READY: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "bar-order-ready:<memberOrderId>:<userId>" },
  BAR_TAB_SETTLED: { channels: PUSH_ONLY, whatsapp: null, urgency: "normal", dedupe: "bar-tab-settled:<tabId>:<userId>" },
};

// ───────── v4 §4.2 quiet hours (NT-7) ─────────

export const QUIET_HOURS = { start: 22, end: 7 } as const;

/** 22:00–07:00 IST. */
export function inQuietHours(at: Date): boolean {
  const h = istParts(at).hour;
  return h >= QUIET_HOURS.start || h < QUIET_HOURS.end;
}

/** The next 07:00 IST at or after `at`. */
export function quietHoursEnd(at: Date): Date {
  const today = istDate(at);
  const morning = istToUtc(today, "07:00");
  return at.getTime() < morning.getTime() ? morning : istToUtc(addDays(today, 1), "07:00");
}

/**
 * NT-7: which pushes go out in the quiet hours — session reminders, and a club cancellation of a session today (or
 * one that starts before the hold would end + 2 h, e.g. tomorrow 06:30 cancelled at 23:00). Everything else waits.
 */
export function pushIsUrgent(m: Pick<MemberMessage, "event" | "urgent" | "sessionAt">, now: Date): boolean {
  if (m.urgent !== undefined) return m.urgent;
  if (m.event === "SESSION_REMINDER" || m.event === "SOCIAL_SESSION_REMINDER") return true;
  if (m.event === "BOOKING_CANCELLED_BY_CLUB") {
    if (!m.sessionAt) return true;
    return istDate(m.sessionAt) === istDate(now) || m.sessionAt.getTime() <= quietHoursEnd(now).getTime() + 2 * HOUR;
  }
  return false;
}

/** When a push queued now may be sent: null = at once; else the end of the quiet hours. */
export function pushNotBefore(urgent: boolean, now: Date): Date | null {
  return urgent || !inQuietHours(now) ? null : quietHoursEnd(now);
}

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");
export const absolute = (link: string | null | undefined) => (!link ? "" : /^https?:\/\//.test(link) ? link : `${appUrl()}${link}`);

function cuid(): string {
  return "nd_" + globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

type DeliveryInsert = {
  event: string; dedupeKey: string; channel: Channel; status: DeliveryStatus; userId: string | null; guestId?: string | null; memberId?: string | null;
  to?: string | null; title: string; body: string; link?: string | null; whatsappText?: string | null; error?: string | null; triggeredBy?: string | null;
  notBefore?: Date | null; urgent?: boolean; wa?: { template: string; language: string; params: string[]; buttonParam: string | null } | null;
  /** The template the event meant to use when the automatic message was not possible (shown in the WhatsApp log). */
  waTemplate?: string | null;
};

/** One delivery row; the id, or null when this dedupe key + channel already exists (exactly once). */
async function insertDelivery(tx: Tx, d: DeliveryInsert): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO notification_deliveries (id, event, dedupe_key, channel, status, user_id, guest_id, member_id, to_address, title, body, link, whatsapp_text, error,
                                         triggered_by, sent_at, not_before, urgent, wa_template, wa_language, wa_params, wa_button_param, updated_at)
    VALUES (${cuid()}, ${d.event}, ${d.dedupeKey}, ${d.channel}, ${d.status}, ${d.userId}, ${d.guestId ?? null}, ${d.memberId ?? null}, ${d.to ?? null}, ${d.title}, ${d.body},
            ${d.link ?? null}, ${d.whatsappText ?? null}, ${d.error ?? null}, ${d.triggeredBy ?? null}, ${d.status === "SENT" ? clock.now() : null},
            ${d.notBefore ?? null}, ${d.urgent ?? false}, ${d.wa?.template ?? d.waTemplate ?? null}, ${d.wa?.language ?? null},
            ${d.wa ? JSON.stringify(d.wa.params) : null}::jsonb, ${d.wa?.buttonParam ?? null}, now())
    ON CONFLICT (dedupe_key, channel) DO NOTHING RETURNING id`;
  return rows[0]?.id ?? null;
}

/** The text of a manual WhatsApp task (and of the fallback when the API can't send). */
function manualText(m: { title: string; body: string; link?: string | null }) {
  return [m.title, m.body, absolute(m.link)].filter(Boolean).join("\n");
}

type WaPlan = { ok: true; wa: { template: string; language: string; params: string[]; buttonParam: string | null } } | { ok: false; reason: string };

/**
 * WA-55: the WhatsApp API is used only when it is on, the event's template is mapped and APPROVED, and the person
 * opted in. Otherwise the reason is recorded and the manual task is the fallback.
 */
async function planWhatsApp(tx: Tx, wa: WaMessage | undefined, who: { userId?: string | null; guestId?: string | null }): Promise<WaPlan> {
  if (!wa) return { ok: false, reason: "No WhatsApp template for this message" };
  if (!(await whatsappReady(tx))) return { ok: false, reason: `WhatsApp API not available: ${(await getCapabilities())["whatsapp.api"].reason}` };
  const t = await templateFor(tx, wa.template);
  if (!t) return { ok: false, reason: `Template ${wa.template} is not set up in Settings → WhatsApp` };
  if (!t.approved) return { ok: false, reason: `Template ${t.name} is not approved by Meta yet` };
  if (!(await whatsappOptedIn(tx, who))) return { ok: false, reason: "Not opted in to WhatsApp updates" };
  const built = buildTemplate(wa);
  return { ok: true, wa: { template: t.name, language: t.language, params: built.params, buttonParam: built.buttonParam } };
}

/** §5.4 step 2: rows queued in this transaction are sent right after it commits (never if it rolls back). */
const dispatchAfterCommit = new WeakMap<Tx, string[]>();
function sendAfterCommit(tx: Tx, deliveryId: string) {
  const ids = dispatchAfterCommit.get(tx);
  if (ids) {
    ids.push(deliveryId);
    return;
  }
  const list = [deliveryId];
  dispatchAfterCommit.set(tx, list);
  afterCommit(tx, () => dispatchWhatsApp(list));
}

/**
 * Reach a member (or a guardian, or a staff member for staff events) on the channels of the event. Returns one line
 * per channel. Calling it again with the same dedupe key changes nothing (exactly once per channel).
 */
export async function notifyMember(tx: Tx, m: MemberMessage): Promise<Array<{ channel: Channel; status: DeliveryStatus; reason?: string }>> {
  const cat = EVENT_CATALOGUE[m.event];
  const triggeredBy = m.actor ? (m.actor.kind === "USER" ? actorId(m.actor) : "system") : "system";
  const base = { event: m.event, dedupeKey: m.dedupeKey, userId: m.userId, memberId: m.memberId ?? null, title: m.title, body: m.body, link: m.link ?? null, triggeredBy };
  // In-app first: it is the exactly-once gate for the whole fan-out.
  if (!(await insertDelivery(tx, { ...base, channel: "IN_APP", status: "SENT" }))) return [];
  await notify(tx, { userIds: [m.userId], type: m.event, title: m.title, body: m.body, link: m.link ?? null, dedupeKey: m.dedupeKey });
  const out: Array<{ channel: Channel; status: DeliveryStatus; reason?: string }> = [{ channel: "IN_APP", status: "SENT" }];
  const wanted = new Set<Channel>((m.channels ?? cat.channels).filter((c) => cat.channels.includes(c)));
  if (!wanted.size) return out;
  const user = await tx.user.findUniqueOrThrow({ where: { id: m.userId }, select: { phone: true, email: true, notifyPush: true, notifyEmail: true, notifyWhatsapp: true } });
  const caps = await getCapabilities();
  const now = clock.now();
  const record = async (channel: Channel, status: DeliveryStatus, extra: Partial<DeliveryInsert> & { reason?: string } = {}) => {
    if (!wanted.has(channel)) return null;
    const { reason, ...rest } = extra;
    const id = await insertDelivery(tx, { ...base, ...rest, channel, status, error: status === "SKIPPED" ? reason ?? null : rest.error ?? null });
    out.push({ channel, status, reason });
    return id;
  };

  // Web Push (urgent pushes skip the quiet hours)
  if (wanted.has("PUSH")) {
    const subs = caps.push.enabled ? await tx.pushSubscription.count({ where: { userId: m.userId } }) : 0;
    if (!caps.push.enabled) await record("PUSH", "SKIPPED", { reason: `Push not available: ${caps.push.reason}` });
    else if (!user.notifyPush) await record("PUSH", "SKIPPED", { reason: "Turned off by the member" });
    else if (!subs) await record("PUSH", "SKIPPED", { reason: "No device has turned on notifications" });
    else {
      const urgent = pushIsUrgent(m, now);
      await record("PUSH", "QUEUED", { urgent, notBefore: pushNotBefore(urgent, now) });
    }
  }

  // Email
  if (wanted.has("EMAIL")) {
    if (!caps.email.enabled) await record("EMAIL", "SKIPPED", { reason: `Email not available: ${caps.email.reason}` });
    else if (!user.email) await record("EMAIL", "SKIPPED", { reason: "No email address" });
    else if (!user.notifyEmail) await record("EMAIL", "SKIPPED", { reason: "Turned off by the member" });
    else await record("EMAIL", "QUEUED", { to: user.email });
  }

  // WhatsApp: the Cloud API when it is on, the template approved and the person opted in; otherwise a manual task.
  if (wanted.has("WHATSAPP_API") || wanted.has("WHATSAPP_MANUAL")) {
    const number = toWhatsAppNumber(user.phone);
    const text = manualText(m);
    if (!number) {
      await record("WHATSAPP_API", "SKIPPED", { reason: "No mobile number" });
      await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "No mobile number" });
    } else if (!user.notifyWhatsapp) {
      await record("WHATSAPP_API", "SKIPPED", { reason: "Turned off by the member" });
      await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "Turned off by the member" });
    } else {
      const plan = wanted.has("WHATSAPP_API") ? await planWhatsApp(tx, m.wa, { userId: m.userId }) : ({ ok: false, reason: "" } as WaPlan);
      if (plan.ok) {
        const id = await record("WHATSAPP_API", "QUEUED", { to: number, whatsappText: text, wa: plan.wa });
        await record("WHATSAPP_MANUAL", "SKIPPED", { reason: "Sent automatically by the WhatsApp API" });
        if (id) sendAfterCommit(tx, id);
      } else {
        await record("WHATSAPP_API", "SKIPPED", { reason: plan.reason, waTemplate: m.wa?.template ?? null, to: m.wa ? number : null });
        await record("WHATSAPP_MANUAL", "QUEUED", { to: number, whatsappText: text });
      }
    }
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
 * address and on their phone — the WhatsApp API when it is on, the template approved and the guest opted in, else a
 * manual WhatsApp task for the desk. Only channels with an address get a row. Exactly once per dedupe key + channel.
 */
export async function notifyGuest(tx: Tx, g: { event: MemberEvent; guestId: string; title: string; body: string; dedupeKey: string; link?: string | null; params?: string[]; wa?: WaMessage; actor?: Actor }) {
  const guest = await tx.guest.findUnique({ where: { id: g.guestId }, select: { phone: true, email: true } });
  if (!guest) return [];
  const cat = EVENT_CATALOGUE[g.event];
  const caps = await getCapabilities();
  const base = { event: g.event, dedupeKey: g.dedupeKey, userId: null, guestId: g.guestId, title: g.title, body: g.body, link: g.link ?? null, triggeredBy: g.actor?.kind === "USER" ? actorId(g.actor) : "system" };
  const out: Array<{ channel: Channel; status: DeliveryStatus }> = [];
  const put = async (channel: Channel, status: DeliveryStatus, extra: Partial<DeliveryInsert> = {}) => {
    const id = await insertDelivery(tx, { ...base, ...extra, channel, status });
    if (id) out.push({ channel, status });
    return id;
  };
  if (guest.email && cat.channels.includes("EMAIL")) {
    if (caps.email.enabled) await put("EMAIL", "QUEUED", { to: guest.email });
    else await put("EMAIL", "SKIPPED", { error: `Email not available: ${caps.email.reason}` });
  }
  const number = guest.phone ? toWhatsAppNumber(guest.phone) : null;
  if (number && cat.whatsapp) {
    const text = manualText(g);
    const plan = await planWhatsApp(tx, g.wa, { guestId: g.guestId });
    if (plan.ok) {
      const id = await put("WHATSAPP_API", "QUEUED", { to: number, whatsappText: text, wa: plan.wa });
      if (id) sendAfterCommit(tx, id);
    } else {
      await put("WHATSAPP_MANUAL", "QUEUED", { to: number, whatsappText: text });
    }
  }
  return out;
}

// ───────── worker: claim and send what is due ─────────

type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushOptions = { TTL: number; urgency: "high" | "normal" };
let pushSender: ((sub: PushSub, payload: string, opts: PushOptions) => Promise<unknown>) | null = null;
const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;
/** Tests only: replace the web-push sender, and (`fetch`) the HTTP client of the WhatsApp Cloud API. */
export function setChannelTransportsForTests(t: { push?: ((sub: PushSub, payload: string, opts: PushOptions) => Promise<unknown>) | null; fetch?: typeof fetch | null }) {
  if (!isTest()) throw new Error("channel transport overrides are only available in tests");
  if ("push" in t) pushSender = t.push ?? null;
  if ("fetch" in t) setWhatsAppFetchForTests(t.fetch ?? null);
}

/** The push services' contact: VAPID_SUBJECT, else mailto: the club email, else the club's HTTPS address. */
function vapidSubject(clubEmail: string | null | undefined) {
  return (process.env.VAPID_SUBJECT ?? "").trim() || (clubEmail ? `mailto:${clubEmail}` : appUrl());
}

function sendPush(sub: PushSub, payload: string, opts: PushOptions, subject: string) {
  if (pushSender) return pushSender(sub, payload, opts);
  webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return webpush.sendNotification(sub, payload, { TTL: opts.TTL, urgency: opts.urgency });
}

/** Push TTL: 24 hours (a push service keeps an undelivered message that long). */
export const PUSH_TTL_SECONDS = 24 * 3600;

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** NT-6: what the device shows — `{ title, body, url, tag }`, short — and how urgently the push service delivers it. */
export function pushPayload(d: { event: string; title: string; body: string; link: string | null; dedupeKey: string }): { payload: { title: string; body: string; url: string; tag: string }; options: PushOptions } {
  const row = EVENT_CATALOGUE[d.event as NotifyEvent];
  const tag = `${d.event.toLowerCase().replace(/_/g, "-")}-${createHash("sha256").update(d.dedupeKey).digest("hex").slice(0, 10)}`;
  return {
    payload: { title: cap(d.title, 80), body: cap(d.body.replace(/\s*\n\s*/g, " "), 180), url: d.link || "/", tag },
    options: { TTL: PUSH_TTL_SECONDS, urgency: row?.urgency ?? "normal" },
  };
}

const done = (id: string, data: Prisma.NotificationDeliveryUpdateInput) => prisma.notificationDelivery.update({ where: { id }, data });

/** A failure that another try can't fix (no device left, mailbox refused, capability gone, bad request). */
class PermanentFailure extends Error {}

/** Push and email: tries per message (the first + 3 retries) and the wait after the 1st, 2nd and 3rd failed try. */
export const DELIVERY_MAX_ATTEMPTS = 4;
export const DELIVERY_RETRY_MINUTES = [0, 5, 30, 120] as const;
/** NT-8: push retries at most 3 times (5 min, 30 min, 2 h), then FAILED. */
export const PUSH_MAX_RETRIES = DELIVERY_MAX_ATTEMPTS - 1;
/** WA-52: WhatsApp retries after 30 s, 2 min, 10 min, 30 min and 2 h — at most 5 retries, then FAILED + fallback. */
export const WA_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3600_000] as const;
export const WA_MAX_RETRIES = WA_RETRY_DELAYS_MS.length;
const STALE_SENDING_MS = 10 * 60_000;
/** While a run sends a row it holds it in `handled_by` ("worker:…"; only manual WhatsApp rows name a person there). */
const CLAIM = "worker:";

function isPermanent(channel: string, e: unknown): boolean {
  if (e instanceof PermanentFailure) return true;
  const x = e as { statusCode?: number; responseCode?: number; code?: string; message?: string };
  // Push service: 4xx means the request itself is wrong (gone, unauthorised, too big) — except 429.
  if (channel === "PUSH") return typeof x.statusCode === "number" && x.statusCode >= 400 && x.statusCode < 500 && x.statusCode !== 429;
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
    [club.name || "The club", formatPhone(club.phone)].filter(Boolean).join(" · "),
    who?.role === "MEMBER" && appUrl() ? `To change how the club reaches you: ${appUrl()}/portal/notifications` : "",
  ].filter(Boolean).join("\n\n");
}

/** A run that died mid-send leaves its claim on the row: after 10 minutes the row is free again. */
async function releaseStaleClaims(channels: string[]) {
  const now = clock.now();
  await prisma.notificationDelivery.updateMany({
    where: { status: "QUEUED", channel: { in: channels }, handledBy: { startsWith: CLAIM }, updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { handledBy: null, updatedAt: now },
  });
}

/**
 * Claim due QUEUED rows (§5.4 step 4): `SELECT … FOR UPDATE SKIP LOCKED` picks rows no other run holds, and the same
 * statement marks them with this run's claim, so two workers never send one row twice. In the quiet hours non-urgent
 * pushes are left for later.
 */
async function claimDue(channels: string[], limit: number, opts: { ids?: string[]; quiet?: boolean } = {}): Promise<{ run: string; rows: NotificationDelivery[] }> {
  const now = clock.now();
  const run = `${CLAIM}${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    WITH due AS (
      SELECT id FROM notification_deliveries
       WHERE status = 'QUEUED' AND channel = ANY(${channels}::text[]) AND handled_by IS NULL
         AND (not_before IS NULL OR not_before <= ${now})
         ${opts.ids ? Prisma.sql`AND id = ANY(${opts.ids}::text[])` : Prisma.empty}
         ${opts.quiet ? Prisma.sql`AND NOT (channel = 'PUSH' AND NOT urgent)` : Prisma.empty}
       ORDER BY created_at, id
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE notification_deliveries d SET handled_by = ${run}, updated_at = ${now} FROM due WHERE d.id = due.id RETURNING d.id`;
  if (!claimed.length) return { run, rows: [] };
  const rows = await prisma.notificationDelivery.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return { run, rows };
}

/**
 * Worker job (every minute, and in the 5-minute batch): deliver queued push and email messages and record every
 * outcome on the delivery row. A failure that may pass (timeout, SMTP 4xx, push service 5xx/429) is retried after
 * 5 min, 30 min and 2 h — the row stays "To send" with "Attempt n of 4 failed…" — then FAILED; a permanent one is
 * FAILED at once. A push that hits a dead subscription (404/410) removes it (NT-9). Non-urgent pushes wait out the
 * quiet hours (NT-7). Email failures also go to the message log, every attempt.
 */
export async function flushDeliveries(limit = 100) {
  await releaseStaleClaims(["PUSH", "EMAIL"]);
  const { rows } = await claimDue(["PUSH", "EMAIL"], limit, { quiet: inQuietHours(clock.now()) });
  if (!rows.length) return { sent: 0, failed: 0 };
  const caps = await getCapabilities();
  const club = (await getSettings()).club;
  const result = { sent: 0, failed: 0 };
  for (const d of rows) {
    const before = d.attempts;
    const note = before && d.error ? `Sent on attempt ${before + 1} (before: ${d.error.replace(/^Attempt \d+ of \d+ failed[^:]*:\s*/, "")})`.slice(0, 500) : null;
    try {
      if (d.channel === "PUSH") {
        if (!caps.push.enabled) throw new PermanentFailure(`Push no longer available: ${caps.push.reason}`);
        const subs = await prisma.pushSubscription.findMany({ where: { userId: d.userId ?? "" } });
        if (!subs.length) throw new PermanentFailure("No device has turned on notifications");
        let ok = 0;
        let lastError: unknown = null;
        let transient = false;
        const { payload, options } = pushPayload(d);
        for (const sub of subs) {
          try {
            await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), options, vapidSubject(club.email));
            await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: clock.now() } });
            ok++;
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            lastError = e;
            // NT-9: the browser unsubscribed or the subscription expired — forget it.
            if (code === 404 || code === 410) await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
            else if (!isPermanent("PUSH", e)) transient = true;
          }
        }
        if (!ok) {
          const msg = lastError instanceof Error ? lastError.message : String(lastError);
          throw transient ? new Error(msg) : new PermanentFailure(msg);
        }
        await done(d.id, { status: "SENT", sentAt: clock.now(), error: note, handledBy: null, attempts: before + 1, notBefore: null });
      } else {
        if (!caps.email.enabled) throw new PermanentFailure(`Email no longer available: ${caps.email.reason}`);
        if (!d.toAddress) throw new PermanentFailure("No email address");
        await mailTransport().sendMail({ from: process.env.SMTP_FROM, to: d.toAddress, subject: d.title, text: await emailText(d, club) });
        await done(d.id, { status: "SENT", sentAt: clock.now(), error: note, handledBy: null, attempts: before + 1, notBefore: null });
        await logMessage(prisma, { channel: "EMAIL", to: d.toAddress, subject: d.title, body: d.body, status: "SENT" });
      }
      result.sent++;
    } catch (e) {
      result.failed++;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      const attempt = before + 1;
      const final = isPermanent(d.channel, e) || attempt >= DELIVERY_MAX_ATTEMPTS;
      const now = clock.now();
      let notBefore: Date | null = null;
      if (!final) {
        notBefore = new Date(now.getTime() + DELIVERY_RETRY_MINUTES[attempt] * 60_000);
        // A non-urgent push retry never lands in the quiet hours.
        if (d.channel === "PUSH" && !d.urgent && inQuietHours(notBefore)) notBefore = quietHoursEnd(notBefore);
      }
      const error = final
        ? attempt > 1 ? `${msg} (gave up after ${attempt} attempts)` : msg
        : `Attempt ${attempt} of ${DELIVERY_MAX_ATTEMPTS} failed, trying again in ${DELIVERY_RETRY_MINUTES[attempt]} min: ${msg}`;
      await done(d.id, { status: final ? "FAILED" : "QUEUED", error: error.slice(0, 500), updatedAt: now, handledBy: null, attempts: attempt, notBefore });
      if (d.channel === "EMAIL") {
        await logMessage(prisma, { channel: "EMAIL", to: d.toAddress ?? "", subject: d.title, body: d.body, status: "FAILED", error: final ? msg : `${msg} — will try again` });
      }
      if (!isTest()) console.error(`[deliveries] ${d.channel} ${d.event} to ${d.toAddress ?? d.userId ?? "?"} ${final ? "FAILED" : `attempt ${attempt} failed`}: ${msg}`);
    }
  }
  return result;
}

// ───────── §5.4 WhatsApp Cloud API queue ─────────

/** Until when sending on a channel is paused by a rate limit (null = not paused). */
export async function channelPausedUntil(channel: "WHATSAPP_API"): Promise<Date | null> {
  const p = await prisma.deliveryPause.findUnique({ where: { channel } });
  return p && p.pausedUntil.getTime() > clock.now().getTime() ? p.pausedUntil : null;
}

async function pauseChannel(channel: "WHATSAPP_API", ms: number, reason: string) {
  const until = new Date(clock.now().getTime() + Math.max(1000, ms));
  await prisma.deliveryPause.upsert({ where: { channel }, create: { channel, pausedUntil: until, reason: reason.slice(0, 300), updatedAt: clock.now() }, update: { pausedUntil: until, reason: reason.slice(0, 300), updatedAt: clock.now() } });
  return until;
}

/**
 * WA-53 fallback: the automatic message could not be sent — the desk gets the manual task in "Messages to send" with
 * the same text and a wa.me link (the manual row of the same event + recipient, created or switched from SKIPPED to
 * QUEUED). Idempotent. Also called by the WhatsApp webhook when Meta reports a message as failed.
 */
export async function whatsappFallback(deliveryId: string, reason: string, db: Tx | typeof prisma = prisma): Promise<boolean> {
  const now = clock.now();
  const why = `Automatic WhatsApp failed: ${reason}`.slice(0, 500);
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO notification_deliveries (id, event, dedupe_key, channel, status, user_id, guest_id, member_id, to_address, title, body, link, whatsapp_text, error, triggered_by, created_at, updated_at)
    SELECT ${cuid()}, d.event, d.dedupe_key, 'WHATSAPP_MANUAL', 'QUEUED', d.user_id, d.guest_id, d.member_id, d.to_address, d.title, d.body, d.link,
           COALESCE(d.whatsapp_text, d.title || E'\n' || d.body), ${why}, d.triggered_by, ${now}, ${now}
      FROM notification_deliveries d
     WHERE d.id = ${deliveryId} AND d.channel = 'WHATSAPP_API' AND d.to_address IS NOT NULL
    ON CONFLICT (dedupe_key, channel) DO UPDATE SET status = 'QUEUED', error = EXCLUDED.error, whatsapp_text = EXCLUDED.whatsapp_text, to_address = EXCLUDED.to_address, updated_at = EXCLUDED.updated_at
     WHERE notification_deliveries.status = 'SKIPPED'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * §5.4 steps 2–5, 7, 9 (WA-50…WA-54, WA-56): send queued WhatsApp API rows (these ids, or every due one). Each row is claimed with
 * `FOR UPDATE SKIP LOCKED`; success stores the `wamid` → SENT. RETRY → backoff (30 s, 2 min, 10 min, 30 min, 2 h),
 * at most 5 retries, then FAILED + fallback task; PERMANENT → FAILED at once + fallback task; RATE_LIMITED → all
 * WhatsApp sending pauses for the advised time and the rows stay QUEUED.
 */
export async function dispatchWhatsApp(deliveryIds?: string[], limit = 50) {
  const result = { sent: 0, failed: 0, retrying: 0, paused: false };
  if (deliveryIds && !deliveryIds.length) return result;
  if (await channelPausedUntil("WHATSAPP_API")) return { ...result, paused: true };
  if (!deliveryIds) await releaseStaleClaims(["WHATSAPP_API"]);
  const { rows } = await claimDue(["WHATSAPP_API"], deliveryIds ? deliveryIds.length : limit, { ids: deliveryIds });
  const ready = rows.length ? await whatsappReady() : false;
  for (const [i, d] of rows.entries()) {
    const attempt = d.attempts + 1;
    const now = () => clock.now();
    const fail = async (reason: string, code?: number) => {
      result.failed++;
      // The "failed" step of the status timeline (the same columns Meta's webhook fills in for a later failure).
      await done(d.id, {
        status: "FAILED", error: (attempt > 1 ? `${reason} (gave up after ${attempt} attempts)` : reason).slice(0, 500), handledBy: null, attempts: attempt, notBefore: null, updatedAt: now(),
        waStatus: "failed", waFailedAt: now(), waErrorCode: code ?? null,
      });
      await logMessage(prisma, { channel: "WHATSAPP", to: d.toAddress ?? "", subject: d.title, body: d.whatsappText ?? d.body, status: "FAILED", error: reason });
      await whatsappFallback(d.id, reason);
    };
    if (!ready) {
      await fail(`WhatsApp API no longer available: ${(await getCapabilities())["whatsapp.api"].reason}`);
      continue;
    }
    const params = Array.isArray(d.waParams) ? (d.waParams as unknown[]).map(String) : [];
    if (!d.waTemplate || !d.toAddress) {
      await fail("No approved template or number on this message");
      continue;
    }
    const r = await sendTemplateMessage({ to: d.toAddress, template: d.waTemplate, language: d.waLanguage ?? "en", params, buttonParam: d.waButtonParam });
    if (r.ok) {
      result.sent++;
      const note = d.attempts && d.error ? `Sent on attempt ${attempt} (before: ${d.error.replace(/^Attempt \d+ failed[^:]*:\s*/, "")})`.slice(0, 500) : null;
      await done(d.id, { status: "SENT", sentAt: now(), providerId: r.wamid, error: note, handledBy: null, attempts: attempt, notBefore: null });
      await logMessage(prisma, { channel: "WHATSAPP", to: d.toAddress, subject: d.title, body: d.whatsappText ?? d.body, status: "SENT" });
    } else if (r.kind === "RATE_LIMITED") {
      // §5.4 step 9: stop sending; this row and the rest of the batch stay QUEUED until the pause ends.
      const until = await pauseChannel("WHATSAPP_API", r.pauseMs, r.reason);
      result.paused = true;
      const rest = rows.slice(i).map((x) => x.id);
      await prisma.notificationDelivery.updateMany({ where: { id: { in: rest } }, data: { handledBy: null, notBefore: until, updatedAt: now() } });
      await done(d.id, { error: `Rate limited by WhatsApp, sending paused until ${until.toISOString()}: ${r.reason}`.slice(0, 500) });
      break;
    } else if (r.kind === "RETRY" && attempt <= WA_MAX_RETRIES) {
      result.retrying++;
      const wait = WA_RETRY_DELAYS_MS[attempt - 1];
      const label = wait < 60_000 ? `${wait / 1000} s` : wait < 3600_000 ? `${wait / 60_000} min` : `${wait / 3600_000} h`;
      await done(d.id, { error: `Attempt ${attempt} failed, trying again in ${label}: ${r.reason}`.slice(0, 500), handledBy: null, attempts: attempt, notBefore: new Date(now().getTime() + wait), updatedAt: now() });
      await logMessage(prisma, { channel: "WHATSAPP", to: d.toAddress, subject: d.title, body: d.whatsappText ?? d.body, status: "FAILED", error: `${r.reason} — will try again` });
    } else {
      const code = r.kind === "PERMANENT" ? r.code : undefined;
      await fail(code != null && !r.reason.includes(`#${code}`) ? `#${code} ${r.reason}` : r.reason, code);
    }
  }
  return result;
}

/** Worker job (every 30 s): sweep every due QUEUED WhatsApp row, so a crash between commit and send loses nothing. */
export async function sweepWhatsApp() {
  return dispatchWhatsApp(undefined, 100);
}

// ───────── WhatsApp Cloud API: test message (Settings) ─────────
// The delivery webhook (statuses, STOP, replies) is whatsapp/webhook.ts; a failure it reports calls `whatsappFallback`.

export const whatsappTestSchema = z.object({ to: mobilePhone, template: z.string().trim().min(1).max(100).default("hello_world"), language: z.string().trim().min(2).max(10).default("en_US") });

/** Settings: send one template message to the Owner's phone; success records the verification. */
export async function sendWhatsappTest(actor: Actor, raw: z.input<typeof whatsappTestSchema>) {
  assertCan(actor, "settings");
  const input = parseOrValidation(whatsappTestSchema, raw);
  const cfg = whatsappConfigured();
  if (!cfg.ok) throw new DomainError("CAPABILITY_DISABLED", `WhatsApp API is not configured: ${cfg.reason}.`);
  const to = toWhatsAppNumber(input.to);
  if (!to) throw new DomainError("VALIDATION_FAILED", "Enter a 10-digit Indian mobile number.");
  const r = await sendTemplateMessage({ to, template: input.template, language: input.language, params: [], buttonParam: null });
  if (!r.ok) throw new DomainError("VALIDATION_FAILED", `WhatsApp API: ${r.reason}`);
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

// ───────── member preferences and push subscriptions (NT-10) ─────────

export const preferencesSchema = z.object({ push: z.boolean().optional(), email: z.boolean().optional(), whatsapp: z.boolean().optional() });

function userOf(actor: Actor): string {
  if (actor.kind !== "USER") throw new DomainError("UNAUTHENTICATED", "Please log in.");
  return actor.userId;
}

/** "Chrome on Android", "Safari on iPhone"… from a browser's user agent (shown in the device list). */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Macintosh|Mac OS X/.test(s) ? "Mac" : /CrOS/.test(s) ? "Chromebook" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /CriOS|Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

/** The devices this person turned push on for (own devices only). */
export async function listMyPushDevices(actor: Actor) {
  const userId = userOf(actor);
  const subs = await prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return subs.map((s) => ({ id: s.id, label: deviceLabel(s.userAgent), endpoint: s.endpoint, addedAt: s.createdAt.toISOString(), lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null }));
}

export async function myNotificationSettings(actor: Actor) {
  const userId = userOf(actor);
  const [u, devices, caps] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyPush: true, notifyEmail: true, notifyWhatsapp: true, email: true, phone: true } }),
    listMyPushDevices(actor),
    getCapabilities(),
  ]);
  return {
    inApp: true,
    push: { on: u.notifyPush, available: caps.push.enabled, devices: devices.length, deviceList: devices },
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
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith("https://"), "The push endpoint must be HTTPS."),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  userAgent: z.string().max(300).optional(),
});

/** `POST /api/push/subscriptions`: this browser receives pushes for the logged-in person (turns push on). */
export async function subscribePush(actor: Actor, raw: z.infer<typeof pushSubscriptionSchema>) {
  const userId = userOf(actor);
  const caps = await getCapabilities();
  if (!caps.push.enabled) throw new DomainError("CAPABILITY_DISABLED", "Push notifications are not set up for this club.");
  const s = pushSubscriptionSchema.parse(raw);
  await withTx(async (tx) => {
    const sub = await tx.pushSubscription.upsert({
      where: { endpoint: s.endpoint },
      create: { userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: s.userAgent ?? null },
      update: { userId, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: s.userAgent ?? null },
    });
    await tx.user.update({ where: { id: userId }, data: { notifyPush: true } });
    await audit(tx, actor, "push.subscribe", "push_subscription", sub.id, { after: { device: deviceLabel(s.userAgent) } });
  });
  return myNotificationSettings(actor);
}

/** The browser turned push off: forget its subscription (own subscriptions only). */
export async function unsubscribePush(actor: Actor, endpoint: string) {
  const userId = userOf(actor);
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return myNotificationSettings(actor);
}

/** Notification settings → Remove a device (own devices only). */
export async function removePushDevice(actor: Actor, id: string) {
  const userId = userOf(actor);
  await withTx(async (tx) => {
    const sub = await tx.pushSubscription.findFirst({ where: { id, userId } });
    if (!sub) throw new DomainError("NOT_FOUND", "That device was not found.");
    await tx.pushSubscription.delete({ where: { id: sub.id } });
    await audit(tx, actor, "push.remove_device", "push_subscription", sub.id, { before: { device: deviceLabel(sub.userAgent) } });
  });
  return myNotificationSettings(actor);
}
