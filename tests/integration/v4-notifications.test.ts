// v4 §4 (event catalogue, Web Push) and §5.4 (the WhatsApp sending queue) — PUSH agent.
// NT-5 catalogue · NT-6 push payload · NT-7 quiet hours · NT-8 push retries · NT-9 dead subscriptions · NT-10 devices
// NT-11 session reminder · NT-12 social reminder · NT-13 choice reminders · NT-14 staff events · NT-15 order/booking
// WA-50 queued in the transaction, sent after commit · WA-51 rollback · WA-52 retries · WA-53 permanent + fallback
// WA-54 rate-limit pause · WA-55 no automatic WhatsApp without opt-in/approval · WA-56 claims (SKIP LOCKED) + sweep
// Outbound HTTP (push services, Meta) is mocked; the database is real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { istToUtc } from "@/lib/time";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { SYSTEM } from "@/server/rbac/actor";
import { changePlayers } from "@/server/services/booking";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import {
  DELIVERY_MAX_ATTEMPTS, EVENT_CATALOGUE, PUSH_MAX_RETRIES, PUSH_TTL_SECONDS, WA_MAX_RETRIES, WA_RETRY_DELAYS_MS, channelPausedUntil, deviceLabel,
  dispatchWhatsApp, flushDeliveries, inQuietHours, listMyPushDevices, notifyMember, openManualMessage, pushIsUrgent, pushPayload, quietHoursEnd,
  removePushDevice, setChannelTransportsForTests, subscribePush, sweepWhatsApp, unsubscribePush, type MemberMessage, type PushOptions,
} from "@/server/services/channels";
import { closeCourts, rescheduleClubCancellation } from "@/server/services/closures";
import { listView } from "@/server/services/filters";
import { setMailTransportForTests } from "@/server/services/notifications";
import { runChoiceReminders, runSessionReminders, runSocialSessionReminders } from "@/server/services/reminders";
import { writeSettingTx } from "@/server/services/settings";
import { checkout, counterSale, setOrderStatus, setTicketStatus } from "@/server/services/shop";
import { verifyResolutionToken } from "@/server/services/signed-links";
import { createSocialSession, joinSession } from "@/server/services/social";
import { decideLeave, requestLeave } from "@/server/services/staff";
import { setWhatsAppFetchForTests } from "@/server/services/whatsapp/client";
import { WA_TEMPLATES } from "@/server/services/whatsapp/templates";
import { runFrequentJobs } from "@/server/jobs";
import { makeWorld, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book } from "../helpers/booking";
import { makeProduct } from "../helpers/shop";

let w: World;
const mails: Array<{ to: string; subject: string; text: string }> = [];
type Pushed = { endpoint: string; payload: Record<string, unknown>; opts: PushOptions };
const pushes: Pushed[] = [];
const capturePush = async (sub: { endpoint: string }, payload: string, opts: PushOptions) => void pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });

const WA_ENV = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_API_VERSION: "v23.0" } as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(WA_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(WA_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026 10:00 IST
  setCapabilityOverridesForTests({ email: true, push: true });
  mails.length = 0;
  pushes.length = 0;
  calls.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void mails.push(m as never) });
  setChannelTransportsForTests({ push: capturePush });
});
afterEach(async () => {
  await settleAfterCommit();
  setMailTransportForTests(null);
  setChannelTransportsForTests({ push: null, fetch: null });
  setWhatsAppFetchForTests(null);
  setCapabilityOverridesForTests({ email: true });
});

const at = (date: string, time: string) => clock.set(istToUtc(date, time));
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
let n = 0;

/** A member with an email address, a mobile number (from makeMember) and one device with push turned on. */
async function reachable(name: string) {
  n++;
  const m = await makeMember(w, { name, plan: "SILVER", email: `push${n}@example.com` });
  await subscribePush(m.actor, { endpoint: `https://push.example.net/sub/${n}`, keys: KEYS, userAgent: ANDROID_CHROME });
  return m;
}

/** "CHANNEL:STATUS" rows for one dedupe key prefix or member + event, sorted. */
async function rows(where: { memberId?: string; userId?: string; event?: string; dedupeKey?: string; keyPrefix?: string }) {
  const d = await prisma.notificationDelivery.findMany({
    where: { memberId: where.memberId, userId: where.userId, event: where.event, dedupeKey: where.dedupeKey ?? (where.keyPrefix ? { startsWith: where.keyPrefix } : undefined) },
  });
  return d.map((x) => `${x.channel}:${x.status}`).sort();
}
const delivery = (where: { memberId?: string; userId?: string; event: string; channel: string }) => prisma.notificationDelivery.findFirstOrThrow({ where, orderBy: { createdAt: "desc" } });

// ───────── WhatsApp Cloud API mocked at the HTTP level ─────────
type Call = { to: string; template: string; language: string; params: string[]; button: string | null; committed: boolean };
const calls: Call[] = [];
type Reply = "ok" | { status: number; body?: unknown; headers?: Record<string, string> };
let wamid = 0;
/** Meta answers these replies in order (the last one repeats). Each call records whether its row was already committed. */
function meta(...replies: Reply[]) {
  let i = 0;
  setWhatsAppFetchForTests((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { to: string; template: { name: string; language: { code: string }; components?: Array<{ type: string; parameters: Array<{ text: string }> }> } };
    const comps = body.template.components ?? [];
    // Visible from another connection = the business transaction has committed (nothing is sent before commit).
    const committed = (await prisma.notificationDelivery.count({ where: { channel: "WHATSAPP_API", toAddress: body.to, waTemplate: body.template.name } })) > 0;
    calls.push({
      to: body.to, template: body.template.name, language: body.template.language.code, committed,
      params: comps.find((c) => c.type === "body")?.parameters.map((p) => p.text) ?? [], button: comps.find((c) => c.type === "button")?.parameters[0]?.text ?? null,
    });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r === "ok") return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.TEST${++wamid}` }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch);
}

/** Automatic WhatsApp on: capability, every template mapped + APPROVED (unless listed as not approved), these members opted in. */
async function whatsappOn(memberIds: string[], opts: { notApproved?: string[] } = {}) {
  setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": true });
  const map = Object.fromEntries(Object.keys(WA_TEMPLATES).map((t) => [t, { name: t, language: "en", status: opts.notApproved?.includes(t) ? "PENDING" : "APPROVED", checked_at: null }]));
  await withTx((tx) => writeSettingTx(tx, SYSTEM, "whatsapp_template_map", map));
  if (memberIds.length) await prisma.member.updateMany({ where: { id: { in: memberIds } }, data: { whatsappOptInAt: clock.now() } });
}

/** A direct message with an automatic WhatsApp template (dues reminder) for one member. */
function duesMessage(userId: string, memberId: string, key: string): MemberMessage {
  return {
    event: "DUES_REMINDER", userId, memberId, title: "₹400 due", body: "Please pay at the club.", link: "/portal/invoices", dedupeKey: key,
    wa: { template: "dues_reminder", vars: { name: "Wasim", amount: "400", whatFor: "court booking" } },
  };
}

describe("v4 §4.1 — event catalogue", () => {
  it("NT-5: every catalogue row has its channels (in-app always) and a dedupe key; staff events are in-app + push only", () => {
    const S = (push: boolean, email: boolean, wa: "required" | "optional" | null) => ({ push, email, wa });
    const spec: Record<string, ReturnType<typeof S>> = {
      MEMBERSHIP_WELCOME: S(true, true, "optional"), MEMBERSHIP_EXPIRY: S(true, true, "optional"), DUES_REMINDER: S(true, true, "optional"),
      BOOKING_CONFIRMED: S(true, true, null), BOOKING_PLAYER_ADDED: S(true, true, null), SESSION_REMINDER: S(true, false, null),
      BOOKING_CANCELLED: S(true, true, "required"), BOOKING_CANCELLED_BY_CLUB: S(true, true, "required"), BOOKING_RESCHEDULED: S(true, true, "required"),
      CANCELLATION_CHOICE_REMINDER: S(true, true, "required"),
      REFUND_REQUESTED: S(true, true, "required"), REFUND_APPROVED: S(true, true, "required"), REFUND_READY_TO_COLLECT: S(true, true, "required"),
      REFUND_REJECTED: S(true, true, "required"), REFUND_COLLECTED: S(true, true, "required"), REFUND_UNCLAIMED_REMINDER: S(true, true, "required"),
      ORDER_READY: S(true, true, null), RESTRING_READY: S(true, true, null), SOCIAL_SESSION_REMINDER: S(true, false, null),
      LEAD_ASSIGNED: S(true, false, null), REFUND_APPROVAL_NEEDED: S(true, false, null), DRAWER_VARIANCE: S(true, false, null), LEAVE_DECIDED: S(true, false, null),
    };
    for (const [event, want] of Object.entries(spec)) {
      const row = EVENT_CATALOGUE[event as keyof typeof EVENT_CATALOGUE];
      const got = { push: row.channels.includes("PUSH"), email: row.channels.includes("EMAIL"), wa: row.whatsapp?.use ?? null };
      expect([event, got]).toEqual([event, want]);
      expect([event, row.channels.includes("WHATSAPP_API"), row.channels.includes("WHATSAPP_MANUAL")]).toEqual([event, !!want.wa, !!want.wa]);
      expect(row.dedupe.length).toBeGreaterThan(5);
    }
    // Push urgency: high for club cancellations and same-day reminders only.
    expect(Object.entries(EVENT_CATALOGUE).filter(([, r]) => r.urgency === "high").map(([e]) => e).sort()).toEqual(["BOOKING_CANCELLED_BY_CLUB", "SESSION_REMINDER", "SOCIAL_SESSION_REMINDER"]);
  });

  it("NT-5: the fan-out follows the catalogue — exactly once per dedupe key + channel; a caller can't add channels the event doesn't use", async () => {
    const m = await reachable("Cat Chitra");
    const uid = m.member.userId!;
    const send = (event: MemberMessage["event"], key: string, channels?: MemberMessage["channels"]) =>
      withTx((tx) => notifyMember(tx, { event, userId: uid, memberId: m.memberId, title: "t", body: "b", link: "/portal", dedupeKey: key, channels }));
    await send("SESSION_REMINDER", "k:reminder");
    expect(await rows({ dedupeKey: "k:reminder" })).toEqual(["IN_APP:SENT", "PUSH:QUEUED"]);
    await send("BOOKING_CONFIRMED", "k:confirmed");
    expect(await rows({ dedupeKey: "k:confirmed" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED"]);
    await send("REFUND_APPROVAL_NEEDED", "k:staff", ["PUSH", "EMAIL", "WHATSAPP_MANUAL"]);
    expect(await rows({ dedupeKey: "k:staff" })).toEqual(["IN_APP:SENT", "PUSH:QUEUED"]);
    await send("BOOKING_CANCELLED", "k:cancel");
    // v6 SA-4 (default ONLY_IF_NO_OTHER_CHANNEL): push and email reach the member → no manual WhatsApp task.
    expect(await rows({ dedupeKey: "k:cancel" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED", "WHATSAPP_API:SKIPPED", "WHATSAPP_MANUAL:SKIPPED"]);
    // The same key again: nothing new on any channel.
    expect(await send("BOOKING_CANCELLED", "k:cancel")).toEqual([]);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: "k:cancel" } })).toBe(5);
  });

  it("NT-15: booking confirmed, player added, restring ready and order ready — in-app, push and email, never WhatsApp", async () => {
    const a = await reachable("Book Bina");
    const b = await reachable("Added Arun");
    const bk = await book(w, { time: "18:00", players: [{ memberId: a.memberId }] });
    expect(await rows({ memberId: a.memberId, event: "BOOKING_CONFIRMED" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED"]);
    await changePlayers(w.actors.FRONT_DESK, bk.bookingId, { players: [{ memberId: a.memberId }, { memberId: b.memberId }] });
    expect(await rows({ memberId: b.memberId, event: "BOOKING_PLAYER_ADDED" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED"]);
    expect(await rows({ memberId: a.memberId, event: "BOOKING_PLAYER_ADDED" })).toEqual([]);

    const restring = await makeProduct(w, { name: "Racket restring", category: "SERVICES", price: 80000, isRestring: true });
    await counterSale(w.actors.SHOP_STAFF, { memberId: a.memberId, items: [{ variantId: restring.variantId, qty: 1 }], payments: [{ method: "UPI", reference: utr() }], restring: { racket: "Wilson Blade 98", notes: "24 kg" } });
    const t = await prisma.serviceTicket.findFirstOrThrow();
    await setTicketStatus(w.actors.SHOP_STAFF, t.id, "IN_PROGRESS");
    await setTicketStatus(w.actors.SHOP_STAFF, t.id, "READY");
    expect(await rows({ memberId: a.memberId, event: "RESTRING_READY" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED"]);

    const bag = await makeProduct(w, { name: "Bag", category: "ACCESSORIES", price: 200000, onHand: 3 });
    const o = await checkout(b.actor, { items: [{ variantId: bag.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    await setOrderStatus(w.actors.SHOP_STAFF, o.orderId, "READY_FOR_PICKUP");
    expect(await rows({ memberId: b.memberId, event: "ORDER_READY" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED"]);
    expect(await prisma.notification.count({ where: { userId: b.member.userId!, type: "ORDER_READY" } })).toBe(1);

    await flushDeliveries();
    expect(pushes.map((p) => p.payload.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^Booked: Court 1/), `You were added to ${bk.bookingCode}`, "Your racket is ready", expect.stringMatching(/^Ready to collect: order /)]));
    expect(mails.find((m) => m.to === b.member.email && m.subject.startsWith("Ready to collect"))?.text).toMatch(/ready to collect at the shop counter/);
    expect(await prisma.notificationDelivery.count({ where: { event: { in: ["BOOKING_CONFIRMED", "BOOKING_PLAYER_ADDED", "RESTRING_READY", "ORDER_READY"] }, channel: { in: ["WHATSAPP_API", "WHATSAPP_MANUAL"] } } })).toBe(0);
  });

  it("NT-14: staff events — lead assigned, refund awaiting approval, drawer variance, leave decided — reach staff in-app and by push only", async () => {
    await subscribePush(w.actors.FRONT_DESK, { endpoint: "https://push.example.net/staff/desk", keys: KEYS, userAgent: ANDROID_CHROME });
    await subscribePush(w.actors.MANAGER, { endpoint: "https://push.example.net/staff/mgr", keys: KEYS, userAgent: ANDROID_CHROME });
    const lr = await requestLeave(w.actors.FRONT_DESK, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-20", reason: "family function" });
    await decideLeave(w.actors.MANAGER, lr.id, "APPROVED");
    expect(await rows({ userId: w.actors.FRONT_DESK.userId, event: "LEAVE_DECIDED" })).toEqual(["IN_APP:SENT", "PUSH:QUEUED"]);
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: w.actors.FRONT_DESK.userId, type: "LEAVE_DECIDED" } })).title).toBe("Leave approved");
    // The emitters (REFUND, DRAWER) call notifyMember with the StaffEvent names and channels ["PUSH"].
    for (const [event, key] of [["REFUND_APPROVAL_NEEDED", "refund-approval:x"], ["DRAWER_VARIANCE", "drawer-variance:x"], ["LEAD_ASSIGNED", "lead-assigned:x"]] as const) {
      await withTx((tx) => notifyMember(tx, { event, userId: w.actors.MANAGER.userId, channels: ["PUSH"], title: event, body: "decide", link: "/app", dedupeKey: key }));
      expect([event, await rows({ dedupeKey: key })]).toEqual([event, ["IN_APP:SENT", "PUSH:QUEUED"]]);
    }
    await flushDeliveries();
    expect(pushes.filter((p) => p.endpoint.endsWith("/mgr")).map((p) => p.payload.title).sort()).toEqual(["DRAWER_VARIANCE", "LEAD_ASSIGNED", "REFUND_APPROVAL_NEEDED"]);
    expect(pushes.find((p) => p.endpoint.endsWith("/desk"))?.payload).toMatchObject({ title: "Leave approved", url: `${process.env.APP_URL}/app/staff/me` }); // v6 URL-1
  });
});

describe("v4 §4.1 — reminders", () => {
  it("NT-11: a session reminder 2 hours before (in-app + push, urgent), once; none for a booking made inside the 2 hours", async () => {
    const m = await reachable("Remind Ritu");
    const late = await reachable("Late Lalit");
    const b = await book(w, { time: "13:00", players: [{ memberId: m.memberId }] });
    await book(w, { time: "11:30", players: [{ memberId: late.memberId }] }); // made at 10:00, 1.5 h before
    expect((await runSessionReminders()).sent).toBe(0); // 13:00 is 3 h away
    at("2026-10-12", "11:00");
    expect((await runSessionReminders()).sent).toBe(1);
    expect((await runSessionReminders()).sent).toBe(0);
    expect(await rows({ memberId: m.memberId, event: "SESSION_REMINDER" })).toEqual(["IN_APP:SENT", "PUSH:QUEUED"]);
    expect(await rows({ memberId: late.memberId, event: "SESSION_REMINDER" })).toEqual([]);
    const d = await delivery({ memberId: m.memberId, event: "SESSION_REMINDER", channel: "PUSH" });
    expect([d.dedupeKey, d.urgent, d.notBefore]).toEqual([`session-reminder:${b.bookingId}:${m.memberId}:${m.member.userId}`, true, null]);
    await flushDeliveries();
    const p = pushes.find((x) => x.payload.title === "Reminder: Court 1, today 13:00–14:00")!;
    expect(p.opts).toEqual({ TTL: PUSH_TTL_SECONDS, urgency: "high" });
    expect(p.payload).toMatchObject({ url: `${process.env.APP_URL}/portal/bookings`, body: expect.stringContaining(b.bookingCode) }); // v6 URL-1
    // Within 10 minutes of the start a reminder no longer helps.
    const soon = await reachable("Soon Sona");
    await book(w, { date: "2026-10-13", time: "08:00", players: [{ memberId: soon.memberId }] });
    at("2026-10-13", "07:55");
    expect((await runSessionReminders()).sent).toBe(0);
  });

  it("NT-12: a social play reminder 2 hours before to everyone who joined (in-app + push)", async () => {
    const m = await reachable("Social Sia");
    const s = await createSocialSession(w.actors.MANAGER, { title: "Monday social", date: "2026-10-12", startTime: "14:00", endTime: "16:00", courtIds: [w.courts["Court 2"].id], capacityPerCourt: 8 });
    const id = s.sessions[0].id;
    await joinSession(w.actors.FRONT_DESK, { sessionId: id, player: { memberId: m.memberId }, payment: { kind: "COUNTER", method: "CASH" } });
    expect((await runSocialSessionReminders()).sent).toBe(0);
    at("2026-10-12", "12:05");
    expect((await runSocialSessionReminders()).sent).toBe(1);
    expect((await runSocialSessionReminders()).sent).toBe(0);
    expect(await rows({ memberId: m.memberId, event: "SOCIAL_SESSION_REMINDER" })).toEqual(["IN_APP:SENT", "PUSH:QUEUED"]);
    expect((await delivery({ memberId: m.memberId, event: "SOCIAL_SESSION_REMINDER", channel: "IN_APP" })).dedupeKey).toBe(`social-reminder:${id}:${m.memberId}:${m.member.userId}`);
    await flushDeliveries();
    expect(pushes[pushes.length - 1]).toMatchObject({ payload: { title: "Reminder: Monday social, today 14:00–16:00", url: `${process.env.APP_URL}/portal/social` }, opts: { urgency: "high" } }); // v6 URL-1
  });

  it("NT-13: club-cancellation choice reminders on day 3 and day 6 (daytime), on every channel with the /r link; none once chosen", async () => {
    const a = await reachable("Choose Chetan");
    const b = await reachable("Chosen Charu");
    await whatsappOn([a.memberId, b.memberId]);
    meta("ok");
    await book(w, { date: "2026-10-13", time: "18:00", players: [{ memberId: a.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const bb = await book(w, { date: "2026-10-13", time: "19:00", players: [{ memberId: b.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 1"].id], date: "2026-10-13", startTime: "17:00", endTime: "21:00", reason: "WET_COURT", note: "" });
    await settleAfterCommit();
    const ccb = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: bb.bookingId } });
    await rescheduleClubCancellation(b.actor, ccb.id, { courtId: w.courts["Court 2"].id, date: "2026-10-15", startTime: "18:00" });
    await settleAfterCommit();
    const cc = await prisma.clubCancellation.findFirstOrThrow({ where: { status: "PENDING_CHOICE" } });
    calls.length = 0;
    for (const [day, time, sent] of [["2026-10-14", "10:00", 0], ["2026-10-15", "08:30", 0], ["2026-10-15", "10:00", 1], ["2026-10-15", "15:00", 0], ["2026-10-17", "10:00", 0], ["2026-10-18", "20:30", 0], ["2026-10-18", "11:00", 1], ["2026-10-19", "11:00", 0]] as const) {
      at(day, time);
      expect([day, time, (await runChoiceReminders()).sent]).toEqual([day, time, sent]);
    }
    await settleAfterCommit();
    for (const step of ["D3", "D6"]) {
      expect([step, await rows({ keyPrefix: `choice-reminder:${cc.id}:${step}:` })]).toEqual([step, ["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED", "WHATSAPP_API:SENT", "WHATSAPP_MANUAL:SKIPPED"]]);
    }
    expect(await prisma.notificationDelivery.count({ where: { event: "CANCELLATION_CHOICE_REMINDER", memberId: b.memberId } })).toBe(0); // rescheduled: nothing to choose
    // WhatsApp: cancellation_choice_reminder with the signed /r token for this cancellation as the button.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ template: "cancellation_choice_reminder", to: `91${a.member.phone}`, committed: true, params: ["Choose", expect.stringMatching(/13 Oct 2026$/), expect.stringMatching(/19 Oct/), String(cc.amountPaid / 100)] });
    at("2026-10-18", "11:00"); // the link works until the resolution deadline
    expect(verifyResolutionToken(decodeURIComponent(calls[0].button!))).toEqual({ clubCancellationId: cc.id });
    const email = await delivery({ memberId: a.memberId, event: "CANCELLATION_CHOICE_REMINDER", channel: "EMAIL" });
    expect(email.body).toContain(`Refund (${formatINR(cc.amountPaid)} in full). With no choice by 19 Oct 2026, 10:00 it is refunded automatically.`);
  });

  it("the 5-minute batch runs the reminders and delivers what they queued", async () => {
    const m = await reachable("Batch Bhavna");
    await book(w, { time: "13:00", players: [{ memberId: m.memberId }] });
    at("2026-10-12", "11:02");
    const r = await runFrequentJobs();
    expect(r.sessionReminders.sent).toBe(1);
    expect(await rows({ memberId: m.memberId, event: "SESSION_REMINDER" })).toEqual(["IN_APP:SENT", "PUSH:SENT"]);
  });
});

describe("v4 §4.2 — Web Push", () => {
  it("NT-6: the payload is { title, body, url, tag } — short, specific, with TTL 24 h and the event's urgency", async () => {
    const long = "x".repeat(300);
    const p = pushPayload({ event: "DUES_REMINDER", title: `₹400 due ${long}`, body: `Line one\nline two ${long}`, link: "/portal/invoices", dedupeKey: "dues:b1:1" });
    expect(Object.keys(p.payload).sort()).toEqual(["body", "tag", "title", "url"]);
    expect([p.payload.title.length <= 80, p.payload.body.length <= 180, p.payload.body.includes("\n"), p.payload.url]).toEqual([true, true, false, `${process.env.APP_URL}/portal/invoices`]); // v6 URL-1: absolute on APP_URL
    expect(p.payload.tag).toMatch(/^dues-reminder-[0-9a-f]{10}$/);
    expect(p.options).toEqual({ TTL: 24 * 3600, urgency: "normal" });
    expect(pushPayload({ event: "BOOKING_CANCELLED_BY_CLUB", title: "t", body: "b", link: null, dedupeKey: "c" })).toMatchObject({ payload: { url: `${process.env.APP_URL}/` }, options: { urgency: "high" } }); // v6 URL-1
    expect(pushPayload({ event: "SESSION_REMINDER", title: "t", body: "b", link: "/portal/bookings", dedupeKey: "s" }).options.urgency).toBe("high");
    // What the device receives is exactly that JSON.
    const m = await reachable("Payload Pari");
    await withTx((tx) => notifyMember(tx, { event: "BOOKING_CONFIRMED", userId: m.member.userId!, memberId: m.memberId, title: "Booked: Court 3 18:00–19:00", body: "BK-1 · players: Pari", link: "/portal/bookings", dedupeKey: "nt6" }));
    await flushDeliveries();
    expect(pushes.at(-1)).toEqual({ endpoint: `https://push.example.net/sub/${n}`, payload: { title: "Booked: Court 3 18:00–19:00", body: "BK-1 · players: Pari", url: `${process.env.APP_URL}/portal/bookings`, tag: expect.stringMatching(/^booking-confirmed-/) }, opts: { TTL: PUSH_TTL_SECONDS, urgency: "normal" } });
  });

  it("NT-7: quiet hours 22:00–07:00 IST hold non-urgent pushes until 07:00; urgent ones (same-day club cancellation, reminders) go at once", async () => {
    expect([inQuietHours(istToUtc("2026-10-12", "21:59")), inQuietHours(istToUtc("2026-10-12", "22:00")), inQuietHours(istToUtc("2026-10-13", "06:59")), inQuietHours(istToUtc("2026-10-13", "07:00"))]).toEqual([false, true, true, false]);
    expect(quietHoursEnd(istToUtc("2026-10-12", "23:30"))).toEqual(istToUtc("2026-10-13", "07:00"));
    expect(quietHoursEnd(istToUtc("2026-10-13", "03:00"))).toEqual(istToUtc("2026-10-13", "07:00"));
    const night = istToUtc("2026-10-12", "22:30");
    expect(pushIsUrgent({ event: "BOOKING_CANCELLED_BY_CLUB", sessionAt: istToUtc("2026-10-13", "08:00") }, night)).toBe(true); // before 07:00 + 2 h
    expect(pushIsUrgent({ event: "BOOKING_CANCELLED_BY_CLUB", sessionAt: istToUtc("2026-10-14", "18:00") }, night)).toBe(false);
    expect(pushIsUrgent({ event: "BOOKING_CANCELLED_BY_CLUB", sessionAt: istToUtc("2026-10-12", "21:00") }, istToUtc("2026-10-12", "20:00"))).toBe(true);
    expect(pushIsUrgent({ event: "DUES_REMINDER" }, night)).toBe(false);

    const soon = await reachable("Morning Mira");
    const later = await reachable("Later Lata");
    await book(w, { date: "2026-10-13", time: "08:00", players: [{ memberId: soon.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { date: "2026-10-14", time: "18:00", players: [{ memberId: later.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await flushDeliveries(); // the booking confirmations, in daytime
    mails.length = 0;
    clock.set(night);
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 1"].id], date: "2026-10-13", startTime: "07:00", endTime: "10:00", reason: "MAINTENANCE", note: "net repair" });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 1"].id], date: "2026-10-14", startTime: "17:00", endTime: "20:00", reason: "MAINTENANCE", note: "net repair" });
    await withTx((tx) => notifyMember(tx, duesMessage(later.member.userId!, later.memberId, "nt7:dues")));
    const p1 = await delivery({ memberId: soon.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "PUSH" });
    const p2 = await delivery({ memberId: later.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "PUSH" });
    const p3 = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "nt7:dues", channel: "PUSH" } });
    expect([p1.urgent, p1.notBefore]).toEqual([true, null]);
    expect([p2.urgent, p2.notBefore, p3.notBefore]).toEqual([false, istToUtc("2026-10-13", "07:00"), istToUtc("2026-10-13", "07:00")]);
    pushes.length = 0;
    await flushDeliveries();
    expect(pushes.map((p) => [p.endpoint.split("/").pop(), p.opts.urgency])).toEqual([[String(n - 1), "high"]]); // only the urgent one
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe("QUEUED");
    // Email is not held by the push quiet hours.
    expect(mails.some((m) => m.to === later.member.email && m.subject.startsWith("Cancelled by the club"))).toBe(true);
    at("2026-10-13", "06:59");
    await flushDeliveries();
    expect(pushes).toHaveLength(1);
    at("2026-10-13", "07:00");
    await flushDeliveries();
    expect(pushes).toHaveLength(3);
    const morning = pushes.slice(1);
    expect(morning.map((p) => [String(p.payload.title).replace(/:.*/, ""), p.opts.urgency]).sort()).toEqual([
      ["Cancelled by the club", "high"], // a club cancellation is high urgency even when it waited
      ["₹400 due", "normal"],
    ]);
  });

  it("NT-8: other push errors fail with backoff (5 min, 30 min, 2 h) — at most 3 retries, then FAILED", async () => {
    expect([PUSH_MAX_RETRIES, DELIVERY_MAX_ATTEMPTS]).toEqual([3, 4]);
    const m = await reachable("Retry Rekha");
    setChannelTransportsForTests({ push: async () => Promise.reject(Object.assign(new Error("Push service 503"), { statusCode: 503 })) });
    await withTx((tx) => notifyMember(tx, { event: "BOOKING_CONFIRMED", userId: m.member.userId!, memberId: m.memberId, title: "t", body: "b", dedupeKey: "nt8" }));
    const row = () => prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "nt8", channel: "PUSH" } });
    const waits: number[] = [];
    for (let i = 1; i <= 3; i++) {
      await flushDeliveries();
      const r = await row();
      expect([r.status, r.attempts, r.error]).toEqual(["QUEUED", i, expect.stringMatching(new RegExp(`^Attempt ${i} of 4 failed, trying again in \\d+ min: Push service 503`))]);
      waits.push((r.notBefore!.getTime() - clock.now().getTime()) / 60_000);
      expect(await flushDeliveries()).toEqual({ sent: 0, failed: 0 }); // backing off
      clock.set(r.notBefore!);
    }
    expect(waits).toEqual([5, 30, 120]);
    await flushDeliveries();
    expect(await row()).toMatchObject({ status: "FAILED", attempts: 4, error: "Push service 503 (gave up after 4 attempts)" });
    expect(await prisma.pushSubscription.count({ where: { userId: m.member.userId! } })).toBe(1); // a 5xx keeps the device
  });

  it("NT-9: a 404/410 from the push service removes that subscription; the push still counts as sent on the devices that took it", async () => {
    const m = await reachable("Dead Devika");
    await subscribePush(m.actor, { endpoint: "https://push.example.net/gone", keys: KEYS, userAgent: ANDROID_CHROME });
    setChannelTransportsForTests({ push: async (sub, payload, opts) => (sub.endpoint.endsWith("/gone") ? Promise.reject(Object.assign(new Error("Gone"), { statusCode: 410 })) : capturePush(sub, payload, opts)) });
    await withTx((tx) => notifyMember(tx, { event: "BOOKING_CONFIRMED", userId: m.member.userId!, memberId: m.memberId, title: "t", body: "b", dedupeKey: "nt9:a" }));
    await flushDeliveries();
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "nt9:a", channel: "PUSH" } })).status).toBe("SENT");
    expect((await listMyPushDevices(m.actor)).map((d) => d.endpoint)).toEqual([`https://push.example.net/sub/${n}`]);
    // The last device gone too (404): FAILED at once, no retry, and no device left.
    setChannelTransportsForTests({ push: async () => Promise.reject(Object.assign(new Error("Not Found"), { statusCode: 404 })) });
    await withTx((tx) => notifyMember(tx, { event: "BOOKING_CONFIRMED", userId: m.member.userId!, memberId: m.memberId, title: "t", body: "b", dedupeKey: "nt9:b" }));
    await flushDeliveries();
    expect(await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "nt9:b", channel: "PUSH" } })).toMatchObject({ status: "FAILED", attempts: 1, error: "Not Found" });
    expect(await prisma.pushSubscription.count({ where: { userId: m.member.userId! } })).toBe(0);
  });

  it("NT-10: subscribe (POST /api/push/subscriptions), list devices (browser, added date), remove own devices only, unsubscribe", async () => {
    const m = await makeMember(w, { name: "Device Divya", plan: "SILVER" });
    const other = await makeMember(w, { name: "Other Om", plan: "SILVER" });
    setCapabilityOverridesForTests({ email: true, push: false });
    await expect(subscribePush(m.actor, { endpoint: "https://push.example.net/d1", keys: KEYS })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    setCapabilityOverridesForTests({ email: true, push: true });
    await expect(subscribePush(m.actor, { endpoint: "http://push.example.net/d1", keys: KEYS })).rejects.toThrow(/HTTPS/);
    await prisma.user.update({ where: { id: m.member.userId! }, data: { notifyPush: false } });
    const s = await subscribePush(m.actor, { endpoint: "https://push.example.net/d1", keys: KEYS, userAgent: ANDROID_CHROME });
    await subscribePush(m.actor, { endpoint: "https://push.example.net/d1", keys: KEYS, userAgent: ANDROID_CHROME }); // same browser again
    await subscribePush(m.actor, { endpoint: "https://push.example.net/d2", keys: KEYS, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
    expect(s.push).toMatchObject({ on: true, available: true, devices: 1 }); // enabling a device turns push on
    const devices = await listMyPushDevices(m.actor);
    expect(devices.map((d) => [d.label, d.addedAt.slice(0, 10)]).sort()).toEqual([["Chrome on Android", "2026-10-12"], ["Safari on iPhone", "2026-10-12"]]);
    expect([deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0"), deviceLabel(null)]).toEqual(["Edge on Windows", "Browser"]);
    const d1 = devices.find((d) => d.endpoint.endsWith("/d1"))!;
    await expect(removePushDevice(other.actor, d1.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const after = await removePushDevice(m.actor, d1.id);
    expect(after.push.deviceList.map((d) => d.label)).toEqual(["Safari on iPhone"]);
    expect(await prisma.auditLog.count({ where: { action: { in: ["push.subscribe", "push.remove_device"] }, entityId: d1.id } })).toBe(3);
    await unsubscribePush(other.actor, "https://push.example.net/d2"); // not theirs: nothing happens
    expect(await listMyPushDevices(m.actor)).toHaveLength(1);
    await unsubscribePush(m.actor, "https://push.example.net/d2");
    expect(await listMyPushDevices(m.actor)).toHaveLength(0);
  });
});

describe("v4 §5.4 — the WhatsApp sending queue", () => {
  it("WA-50: closing courts queues one WhatsApp per opted-in affected member in the same transaction; it is sent after commit (wamid → SENT)", async () => {
    const a = await reachable("Opted Ojas");
    const b = await reachable("Opted Oviya");
    const c = await reachable("Not Opted Neel");
    await whatsappOn([a.memberId, b.memberId]);
    meta("ok");
    const ba = await book(w, { time: "17:00", players: [{ memberId: a.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { time: "18:00", players: [{ memberId: b.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { time: "19:00", players: [{ memberId: c.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 1"].id], date: "2026-10-12", startTime: "16:00", endTime: "21:00", reason: "WET_COURT", note: "" });
    await settleAfterCommit();
    expect(calls.map((x) => [x.to, x.template, x.committed]).sort()).toEqual([[`91${a.member.phone}`, "club_session_cancelled", true], [`91${b.member.phone}`, "club_session_cancelled", true]]);
    const api = await delivery({ memberId: a.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API" });
    expect(api).toMatchObject({ status: "SENT", providerId: expect.stringMatching(/^wamid\.TEST\d+$/), waTemplate: "club_session_cancelled", waLanguage: "en", attempts: 1, toAddress: `91${a.member.phone}` });
    const call = calls.find((x) => x.to === api.toAddress)!;
    expect(api.waParams).toEqual(call.params);
    expect(call.params).toHaveLength(WA_TEMPLATES.club_session_cancelled.vars.length);
    const cca = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: ba.bookingId } });
    expect(verifyResolutionToken(decodeURIComponent(call.button!))).toEqual({ clubCancellationId: cca.id });
    expect(await rows({ memberId: a.memberId, event: "BOOKING_CANCELLED_BY_CLUB" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED", "WHATSAPP_API:SENT", "WHATSAPP_MANUAL:SKIPPED"]);
    // WA-55: no automatic WhatsApp to a member who did not opt in — the desk's manual task instead, the reason logged.
    expect(calls.some((x) => x.to === `91${c.member.phone}`)).toBe(false);
    const cApi = await delivery({ memberId: c.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API" });
    expect([cApi.status, cApi.error]).toEqual(["SKIPPED", "Not opted in to WhatsApp updates"]);
    // v6 SA-4: push and email reach her, so no manual task either (the default ONLY_IF_NO_OTHER_CHANNEL).
    expect((await delivery({ memberId: c.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_MANUAL" })).status).toBe("SKIPPED");
    // Nothing is left for the sweep; the message log has the sends.
    expect(await sweepWhatsApp()).toEqual({ sent: 0, failed: 0, retrying: 0, paused: false });
    expect(await prisma.messageLog.count({ where: { channel: "WHATSAPP", status: "SENT" } })).toBe(2);
  });

  it("WA-51: a transaction that rolls back sends nothing and leaves no row; one that commits sends at once", async () => {
    const m = await reachable("Rollback Ravi");
    await whatsappOn([m.memberId]);
    meta("ok");
    await expect(withTx(async (tx) => {
      await notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa51:a"));
      throw new Error("the business rule failed");
    })).rejects.toThrow("the business rule failed");
    await settleAfterCommit();
    expect(calls).toHaveLength(0);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: "wa51:a" } })).toBe(0);
    expect(await sweepWhatsApp()).toMatchObject({ sent: 0 });
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa51:b")));
    await settleAfterCommit();
    expect(calls.map((c) => [c.template, c.params, c.committed])).toEqual([["dues_reminder", ["Wasim", "400", "court booking"], true]]);
  });

  it("WA-52: Meta answers 500 → retried after 30 s, then sent; always failing → 30 s, 2 min, 10 min, 30 min, 2 h, then FAILED + the manual task", async () => {
    const m = await reachable("Retry Rohan");
    await whatsappOn([m.memberId]);
    // v6 SA-4: the v4 fallback task for a member also reached by push/email needs `manual_whatsapp_fallback` ALWAYS
    // (the default ONLY_IF_NO_OTHER_CHANNEL makes none — covered in v6-send-all SA-4).
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_whatsapp_fallback", "ALWAYS"));
    meta({ status: 500, body: { error: { message: "Internal error" } } }, "ok");
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa52:a")));
    await settleAfterCommit();
    const row = (key: string) => prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: key, channel: "WHATSAPP_API" } });
    let r = await row("wa52:a");
    expect([r.status, r.attempts, r.error, r.notBefore!.getTime() - clock.now().getTime()]).toEqual(["QUEUED", 1, expect.stringMatching(/^Attempt 1 failed, trying again in 30 s: HTTP 500/), 30_000]);
    expect(await sweepWhatsApp()).toMatchObject({ sent: 0, retrying: 0 }); // not due yet
    clock.set(new Date(clock.now().getTime() + 30_000));
    expect(await sweepWhatsApp()).toMatchObject({ sent: 1 });
    r = await row("wa52:a");
    expect([r.status, r.attempts, r.error]).toEqual(["SENT", 2, expect.stringMatching(/^Sent on attempt 2 \(before: HTTP 500/)]);
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa52:a", channel: "WHATSAPP_MANUAL" } })).status).toBe("SKIPPED");

    expect([WA_MAX_RETRIES, ...WA_RETRY_DELAYS_MS]).toEqual([5, 30_000, 120_000, 600_000, 1_800_000, 7_200_000]);
    meta({ status: 503 });
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa52:b")));
    await settleAfterCommit();
    const waits: number[] = [];
    for (let i = 0; i < WA_MAX_RETRIES; i++) {
      r = await row("wa52:b");
      expect([r.status, r.attempts]).toEqual(["QUEUED", i + 1]);
      waits.push(r.notBefore!.getTime() - clock.now().getTime());
      clock.set(r.notBefore!);
      await sweepWhatsApp();
    }
    expect(waits).toEqual([...WA_RETRY_DELAYS_MS]);
    r = await row("wa52:b");
    expect([r.status, r.attempts, r.error]).toEqual(["FAILED", 6, "HTTP 503 (gave up after 6 attempts)"]);
    const manual = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa52:b", channel: "WHATSAPP_MANUAL" } });
    expect([manual.status, manual.error, manual.whatsappText]).toEqual(["QUEUED", "Automatic WhatsApp failed: HTTP 503", r.whatsappText]);
  });

  it("WA-53: a permanent error (not on WhatsApp) fails at once — no retry — and the same text appears in Messages to send", async () => {
    const m = await reachable("Permanent Pooja");
    await whatsappOn([m.memberId]);
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_whatsapp_fallback", "ALWAYS")); // v6 SA-4: see WA-52
    meta({ status: 400, body: { error: { code: 131026, title: "Message undeliverable" } } });
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa53")));
    await settleAfterCommit();
    expect(calls).toHaveLength(1);
    const api = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa53", channel: "WHATSAPP_API" } });
    expect(api).toMatchObject({ status: "FAILED", attempts: 1, error: "#131026 Message undeliverable", waStatus: "failed", waErrorCode: 131026, notBefore: null });
    clock.set(new Date(clock.now().getTime() + 3 * 3600_000));
    await sweepWhatsApp();
    expect(calls).toHaveLength(1); // never retried
    const manual = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa53", channel: "WHATSAPP_MANUAL" } });
    expect([manual.status, manual.toAddress, manual.error]).toEqual(["QUEUED", `91${m.member.phone}`, "Automatic WhatsApp failed: #131026 Message undeliverable"]);
    expect(manual.whatsappText).toBe("₹400 due\nPlease pay at the club.\nhttp://localhost:3200/portal/invoices");
    expect((await openManualMessage(w.actors.FRONT_DESK, manual.id)).url).toMatch(new RegExp(`^https://wa\\.me/91${m.member.phone}\\?text=`));
    // The other channels went out as usual; the message log shows the original failure.
    expect(await rows({ dedupeKey: "wa53" })).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED", "WHATSAPP_API:FAILED", "WHATSAPP_MANUAL:LINK_OPENED"]);
    expect(await prisma.messageLog.count({ where: { channel: "WHATSAPP", status: "FAILED", error: { contains: "131026" } } })).toBe(1);
    // §5.4 step 8: the Owner's WhatsApp log — template, masked number, timeline, error, tries; filters event/template/status/date.
    const log = await listView(w.actors.OWNER, "whatsapp-log", { status: "FAILED", template: "dues_reminder", event: "DUES_REMINDER", range: "TODAY" });
    expect(log.rows.map((r) => [r.wa_template, r.recipient_phone, r.attempts, r.error, r.failed_at !== null, r.manual_status])).toEqual([
      ["dues_reminder", `+91 ••••••${m.member.phone.slice(-4)}`, 1, "#131026 Message undeliverable", true, "LINK_OPENED"],
    ]);
    expect(JSON.stringify(log.rows)).not.toContain(m.member.phone);
    await expect(listView(w.actors.FRONT_DESK, "whatsapp-log", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const nlog = await listView(w.actors.OWNER, "notifications", { channel: "WHATSAPP_API", template: "dues_reminder" });
    expect(nlog.rows.map((r) => [r.to_address, r.attempts, r.status])).toEqual([[`+91 ••••••${m.member.phone.slice(-4)}`, 1, "FAILED"]]);
  });

  it("WA-54: a rate limit pauses all WhatsApp sending for the advised time; the rows stay QUEUED and go out after the pause", async () => {
    const a = await reachable("Rate Rhea");
    const b = await reachable("Rate Rudra");
    await whatsappOn([a.memberId, b.memberId]);
    meta({ status: 429, body: { error: { code: 130429, message: "Rate limit hit" } }, headers: { "retry-after": "120" } });
    // Queued outside withTx (no after-commit send): the sweep picks both up.
    await prisma.$transaction(async (tx) => {
      await notifyMember(tx, duesMessage(a.member.userId!, a.memberId, "wa54:a"));
      await notifyMember(tx, duesMessage(b.member.userId!, b.memberId, "wa54:b"));
    });
    const r = await sweepWhatsApp();
    expect(r).toMatchObject({ sent: 0, failed: 0, paused: true });
    expect(calls).toHaveLength(1); // stopped at the first answer
    const until = await channelPausedUntil("WHATSAPP_API");
    expect(until!.getTime() - clock.now().getTime()).toBe(120_000);
    const q = await prisma.notificationDelivery.findMany({ where: { dedupeKey: { in: ["wa54:a", "wa54:b"] }, channel: "WHATSAPP_API" } });
    expect(q.map((x) => [x.status, x.attempts, x.handledBy])).toEqual([["QUEUED", 0, null], ["QUEUED", 0, null]]);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: { in: ["wa54:a", "wa54:b"] }, channel: "WHATSAPP_MANUAL", status: "QUEUED" } })).toBe(0); // no fallback for a pause
    meta("ok");
    expect(await dispatchWhatsApp(q.map((x) => x.id))).toMatchObject({ paused: true, sent: 0 });
    expect(calls).toHaveLength(1);
    clock.set(new Date(clock.now().getTime() + 120_001));
    expect(await sweepWhatsApp()).toMatchObject({ sent: 2, paused: false });
    expect(await channelPausedUntil("WHATSAPP_API")).toBeNull();
  });

  it("WA-55: no automatic WhatsApp when the template isn't approved, the capability is off or the member turned WhatsApp off — the manual task instead", async () => {
    const m = await reachable("Fallback Farhan");
    await whatsappOn([m.memberId], { notApproved: ["dues_reminder"] });
    meta("ok");
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa55:a")));
    setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": false });
    await withTx((tx) => notifyMember(tx, duesMessage(m.member.userId!, m.memberId, "wa55:b")));
    await settleAfterCommit();
    const why = async (key: string) => {
      const d = await prisma.notificationDelivery.findMany({ where: { dedupeKey: key, channel: { in: ["WHATSAPP_API", "WHATSAPP_MANUAL"] } }, orderBy: { channel: "asc" } });
      return d.map((x) => [x.channel, x.status, x.error]);
    };
    // v6 SA-4 (default ONLY_IF_NO_OTHER_CHANNEL): push and email reach Farhan, so the manual task is SKIPPED with the reason.
    const reached = "Reached by push or email (manual WhatsApp only when nothing else reaches them)";
    expect(await why("wa55:a")).toEqual([["WHATSAPP_API", "SKIPPED", "Template dues_reminder is not approved by Meta yet"], ["WHATSAPP_MANUAL", "SKIPPED", reached]]);
    expect(await why("wa55:b")).toEqual([["WHATSAPP_API", "SKIPPED", "WhatsApp API not available: disabled (test override)"], ["WHATSAPP_MANUAL", "SKIPPED", reached]]);
    expect(calls).toHaveLength(0);
  });

  it("WA-56: rows are claimed with FOR UPDATE SKIP LOCKED — two sweeps at once never send one row twice; a row whose after-commit send was lost is swept", async () => {
    const members = [await reachable("Claim One"), await reachable("Claim Two"), await reachable("Claim Three")];
    await whatsappOn(members.map((m) => m.memberId));
    meta("ok");
    // As if the process died right after commit: rows written without the after-commit send.
    await prisma.$transaction(async (tx) => {
      for (const [i, m] of members.entries()) await notifyMember(tx, duesMessage(m.member.userId!, m.memberId, `wa56:${i}`));
    });
    const [x, y] = await Promise.all([sweepWhatsApp(), sweepWhatsApp()]);
    expect(x.sent + y.sent).toBe(3);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.to)).size).toBe(3);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: { startsWith: "wa56:" }, channel: "WHATSAPP_API", status: "SENT" } })).toBe(3);
  });
});
