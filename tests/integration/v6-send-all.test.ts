// v6 §2 (SENDALL) "Send all automatically" + §1 URL-3 (render at send time). Outbound HTTP is mocked (WhatsApp Cloud
// API fetch, mail transport, Web Push sender); the database is real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { absoluteUrl } from "@/lib/url";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { SYSTEM } from "@/server/rbac/actor";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { markManualSent, notifyGuest, notifyMember, openManualMessage, setChannelTransportsForTests, subscribePush, type MemberMessage } from "@/server/services/channels";
import { createBulkSend } from "@/server/services/messages/bulk";
import { setMessagePushSenderForTests } from "@/server/services/messages/delivery";
import { cleanManualQueue, isStillRelevant } from "@/server/services/messages/manual-queue";
import { runSendAllJobs, sendAllPreflight, sendAllProgress, startSendAll } from "@/server/services/messages/send-all";
import { ensureReadyMadeTemplates } from "@/server/services/messages/templates";
import { setMailTransportForTests } from "@/server/services/notifications";
import { renewMembership } from "@/server/services/membership";
import { recordCounterPayment } from "@/server/services/payments";
import { writeSettingTx } from "@/server/services/settings";
import { setWhatsAppFetchForTests } from "@/server/services/whatsapp/client";
import { WA_TEMPLATES } from "@/server/services/whatsapp/templates";
import { makeMember } from "../helpers/members";
import { makeWorld, utr, type World } from "../helpers/world";

let w: World;
type Mail = { to: string; subject: string; text: string; html: string };
const mails: Mail[] = [];
const pushes: Array<{ endpoint: string; payload: { title: string; body: string; url: string } }> = [];
type Call = { url: string; to: string; template: string; params: string[] };
const calls: Call[] = [];

const WA_ENV = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_API_VERSION: "v23.0" } as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(WA_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  savedEnv.APP_URL = process.env.APP_URL;
});
afterAll(() => {
  for (const k of [...Object.keys(WA_ENV), "APP_URL"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026, 10:00 IST
  await ensureReadyMadeTemplates();
  process.env.APP_URL = savedEnv.APP_URL;
  setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": false });
  mails.length = 0;
  pushes.length = 0;
  calls.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void mails.push(m as unknown as Mail) });
  setMessagePushSenderForTests(async (sub, payload) => void pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }));
  setChannelTransportsForTests({ push: async (sub, payload) => void pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }) });
});
afterEach(async () => {
  await settleAfterCommit();
  setMailTransportForTests(null);
  setMessagePushSenderForTests(null);
  setChannelTransportsForTests({ push: null, fetch: null });
  setWhatsAppFetchForTests(null);
  setCapabilityOverridesForTests({ email: true });
  process.env.APP_URL = savedEnv.APP_URL;
});

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
let n = 0;
const DUES = "type=DUES_REMINDER";
const sleep = async (ms: number) => void clock.set(new Date(clock.now().getTime() + ms));
const err = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code: string; message: string });

/** A member: optional email, push device, WhatsApp opt-in. */
async function person(name: string, opts: { email?: boolean; push?: boolean; optIn?: boolean; pay?: boolean } = {}) {
  n++;
  const m = await makeMember(w, { name, plan: "SILVER", pay: opts.pay, email: opts.email ? `sa${n}@example.com` : undefined });
  if (opts.push) await subscribePush(m.actor, { endpoint: `https://push.example.net/sa/${n}`, keys: KEYS, userAgent: ANDROID });
  if (opts.optIn) await prisma.member.update({ where: { id: m.memberId }, data: { whatsappOptInAt: clock.now() } });
  return m;
}

type P = Awaited<ReturnType<typeof person>>;

function dues(m: P, key: string, extra: Partial<MemberMessage> = {}): MemberMessage {
  return {
    event: "DUES_REMINDER", userId: m.member.userId!, memberId: m.memberId, title: "₹400 due", body: `Please pay at the club. Details: ${absoluteUrl("/portal/payments")}`,
    link: "/portal/payments", dedupeKey: key, wa: { template: "dues_reminder", vars: { name: m.member.name.split(" ")[0], amount: "400", whatFor: "court booking" } }, ...extra,
  };
}

/** A manual WhatsApp task as the v4 fan-out leaves it when nothing else reached the person (email/push off then). */
async function manualTask(m: P, key: string, extra: Partial<MemberMessage> = {}) {
  setCapabilityOverridesForTests({ email: false, push: false, "whatsapp.api": false });
  await withTx((tx) => notifyMember(tx, dues(m, key, extra)));
  setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": false });
  return prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: extra.dedupeKey ?? key, channel: "WHATSAPP_MANUAL" } });
}

const ageTask = (id: string, ms: number) => prisma.notificationDelivery.update({ where: { id }, data: { createdAt: new Date(clock.now().getTime() - ms) } });

async function apiOn() {
  setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": true });
  const map = Object.fromEntries(Object.keys(WA_TEMPLATES).map((t) => [t, { name: t, language: "en", status: "APPROVED", checked_at: null }]));
  await withTx((tx) => writeSettingTx(tx, SYSTEM, "whatsapp_template_map", map));
}

type Reply = "ok" | { status: number; body?: unknown; headers?: Record<string, string> };
let wamid = 0;
function meta(...replies: Reply[]) {
  let i = 0;
  setWhatsAppFetchForTests((async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { to: string; template: { name: string; components?: Array<{ type: string; parameters: Array<{ text: string }> }> } };
    calls.push({ url: String(url), to: body.to, template: body.template.name, params: body.template.components?.find((c) => c.type === "body")?.parameters.map((p) => p.text) ?? [] });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r === "ok") return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.SA${++wamid}` }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch);
}

const task = (id: string) => prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

describe("v6 §2.2 — clean the queue first", () => {
  it("SA-6: preflight counts are correct for a mixed queue (WhatsApp auto, email / push instead, skipped by reason, can't send), with one sample per channel — nothing changes", async () => {
    const a = await person("Auto Anil", { optIn: true });
    const b = await person("Email Bela", { email: true });
    const c = await person("Push Chirag", { push: true });
    const d = await person("Nobody Dinesh");
    const e = await person("Paid Esha", { pay: false });
    const f = await person("Twice Farah", { email: true });
    const g = await person("Old Gopal", { optIn: true });
    const bill = await prisma.bill.findFirstOrThrow({ where: { memberId: e.memberId } });
    const tA = await manualTask(a, "dues:billA:1");
    const tB = await manualTask(b, "dues:billB:1");
    const tC = await manualTask(c, "dues:billC:1");
    const tD = await manualTask(d, "dues:billD:1");
    const tE = await manualTask(e, `dues:${bill.id}:1`);
    const tF1 = await manualTask(f, "dues:billF:1");
    await ageTask(tF1.id, 3600_000);
    const tF2 = await manualTask(f, "dues:billF:2");
    const tG = await manualTask(g, "dues:billG:1");
    await ageTask(tG.id, 8 * 86_400_000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: bill.total, reference: utr() });
    await apiOn();

    const p = await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES });
    expect(p.total).toBe(8);
    expect(p.whatsappApi.on).toBe(true);
    expect(p.buttonLabel).toBe("Send all");
    expect(p.willSend).toEqual({ tasks: 4, whatsapp: 1, email: 2, push: 1 });
    expect(p.skipped).toMatchObject({ total: 3, notRelevant: 1, duplicate: 1, expired: 1 });
    expect(p.skipped.reasons.map((r) => r.reason).sort()).toEqual(["A newer copy of this message is in the queue", "Older than 7 days", "The bill is paid"]);
    expect(p.cannot.total).toBe(1);
    expect(p.cannot.reasons.map((r) => r.reason).sort()).toEqual(["No email", "No push subscription", "Not opted in"]);
    expect(p.samples.whatsapp).toMatchObject({ template: "dues_reminder", params: ["Auto", "400", "court booking"] });
    expect(p.samples.email?.subject).toBe("₹400 due");
    expect(p.samples.email?.text).toContain(`${process.env.APP_URL}/portal/payments`);
    expect(p.samples.push).toEqual({ title: "₹400 due", body: expect.stringContaining("Please pay at the club") });
    // Nothing was sent or changed.
    for (const t of [tA, tB, tC, tD, tE, tF1, tF2, tG]) expect((await task(t.id)).status).toBe("QUEUED");
    expect(calls).toHaveLength(0);
    expect(mails).toHaveLength(0);
    // "Use other channels" off: only WhatsApp; everything else can't be sent automatically.
    const only = await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES, useOtherChannels: false });
    expect(only.willSend).toEqual({ tasks: 1, whatsapp: 1, email: 0, push: 0 });
    expect(only.cannot.total).toBe(4);
  });

  it("SA-1: paid dues are skipped (SKIPPED_NOT_RELEVANT with the reason) — at confirm, at send time and when opened by hand; also renewed memberships and passwords already set", async () => {
    const m = await person("Dues Deepa", { pay: false, email: true });
    const bill = await prisma.bill.findFirstOrThrow({ where: { memberId: m.memberId } });
    const t1 = await manualTask(m, `dues:${bill.id}:1`);
    expect(await isStillRelevant(t1)).toEqual({ relevant: true });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: bill.total, reference: utr() });
    expect(await isStillRelevant(t1)).toEqual({ relevant: false, reason: "The bill is paid" });
    // Opened by hand: refused and taken out of the queue.
    expect(await err(openManualMessage(w.actors.FRONT_DESK, t1.id))).toMatchObject({ code: "MESSAGE_NOT_RELEVANT", message: expect.stringContaining("the bill is paid") });
    expect(await task(t1.id)).toMatchObject({ status: "SKIPPED_NOT_RELEVANT", error: "The bill is paid" });
    // Welcome / login link to someone who already set a password (makeMember gives a password).
    const k = await person("Pass Kiran");
    const welcome = await manualTask(k, `credentials:${k.member.userId}:1`, { event: "CREDENTIALS_REISSUED", wa: undefined });
    expect(await isStillRelevant(welcome)).toEqual({ relevant: false, reason: "The member has already set a password" });
    // Expiry reminder for a membership that has been renewed.
    const r = await person("Renew Ravi");
    const ms = await prisma.membership.findFirstOrThrow({ where: { memberId: r.memberId } });
    const exp = await manualTask(r, `membership-reminder:${ms.id}:D7:${r.member.userId}`, { event: "MEMBERSHIP_EXPIRY" });
    expect(await isStillRelevant(exp)).toEqual({ relevant: true });
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: ren.billId, method: "UPI", amount: ren.total, reference: utr() });
    expect(await isStillRelevant(exp)).toEqual({ relevant: false, reason: "The membership has been renewed" });
    // Confirmed "Send all": the stale tasks leave the queue with their reason; nothing is sent for them.
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: "" });
    expect(res.job.total).toBe(0);
    expect(await task(welcome.id)).toMatchObject({ status: "SKIPPED_NOT_RELEVANT", error: "The member has already set a password" });
    expect(await task(exp.id)).toMatchObject({ status: "SKIPPED_NOT_RELEVANT", error: "The membership has been renewed" });
    expect(mails).toHaveLength(0);
    // At send time too: a task confirmed while still due, paid before the worker reaches it.
    const m2 = await person("Late Lata", { pay: false, email: true });
    const bill2 = await prisma.bill.findFirstOrThrow({ where: { memberId: m2.memberId } });
    const t2 = await manualTask(m2, `dues:${bill2.id}:1`);
    const job = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    expect(job.job.total).toBe(1);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill2.id, method: "UPI", amount: bill2.total, reference: utr() });
    mails.length = 0;
    await runSendAllJobs({ sleep });
    expect(await task(t2.id)).toMatchObject({ status: "SKIPPED_NOT_RELEVANT", error: "The bill is paid" });
    expect(mails.filter((x) => x.to === m2.member.email)).toHaveLength(0);
    expect(await sendAllProgress(w.actors.FRONT_DESK, job.job.id)).toMatchObject({ status: "DONE", sent: 0, skipped: 1, remaining: 0 });
  });

  it("SA-2: duplicates collapsed — same event + recipient + record keeps only the newest (SKIPPED_DUPLICATE); another person or record is not a duplicate", async () => {
    const m = await person("Dup Divya");
    const o = await person("Other Om");
    const t1 = await manualTask(m, "dues:billX:1");
    await ageTask(t1.id, 3 * 3600_000);
    const t2 = await manualTask(m, "dues:billX:2");
    await ageTask(t2.id, 3600_000);
    const t3 = await manualTask(m, "dues:billX:3");
    const other = await manualTask(o, "dues:billX:1b");
    const otherBill = await manualTask(m, "dues:billY:1");
    const p = await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES });
    expect(p.skipped).toMatchObject({ duplicate: 2, notRelevant: 0, expired: 0 });
    const counts = await cleanManualQueue(SYSTEM);
    expect(counts).toMatchObject({ SKIPPED_DUPLICATE: 2 });
    expect([(await task(t1.id)).status, (await task(t2.id)).status, (await task(t3.id)).status]).toEqual(["SKIPPED_DUPLICATE", "SKIPPED_DUPLICATE", "QUEUED"]);
    expect((await task(other.id)).status).toBe("QUEUED");
    expect((await task(otherBill.id)).status).toBe("QUEUED");
    expect(await prisma.auditLog.count({ where: { action: "message.queue_cleaned" } })).toBe(1);
  });

  it("SA-3: expired tasks are excluded from Send all and can still be sent one by one after a confirmation; the age limit is a setting", async () => {
    const m = await person("Expired Ela", { email: true });
    const t = await manualTask(m, "dues:billE:1");
    await ageTask(t.id, 8 * 86_400_000);
    expect((await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES })).skipped.expired).toBe(1);
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_message_max_age_days", 10));
    const p = await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES });
    expect([p.skipped.expired, p.willSend.email]).toEqual([0, 1]);
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_message_max_age_days", 7));
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    expect(res.job.total).toBe(0);
    expect(await task(t.id)).toMatchObject({ status: "EXPIRED", error: "Older than 7 days" });
    await runSendAllJobs({ sleep });
    expect(mails).toHaveLength(0);
    // By hand: needs a confirmation.
    expect(await err(openManualMessage(w.actors.FRONT_DESK, t.id))).toMatchObject({ code: "MESSAGE_EXPIRED", message: "This message is 8 days old. Send it anyway?" });
    const { url } = await openManualMessage(w.actors.FRONT_DESK, t.id, { confirmExpired: true });
    expect(url).toMatch(new RegExp(`^https://wa\\.me/91${m.member.phone}\\?text=`));
    await markManualSent(w.actors.FRONT_DESK, t.id);
    expect((await task(t.id)).status).toBe("SENT");
    expect(await prisma.auditLog.count({ where: { action: "message.expired_send_confirmed", entityId: t.id } })).toBe(1);
  });

  it("SA-4: manual_whatsapp_fallback — default only when nothing else reaches the person (guests with only a phone keep their task); ALWAYS; NEVER", async () => {
    const m = await person("Reach Rekha", { email: true });
    await withTx((tx) => notifyMember(tx, dues(m, "sa4:default")));
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "sa4:default", channel: "WHATSAPP_MANUAL" } });
    expect([row.status, row.error]).toEqual(["SKIPPED", "Reached by push or email (manual WhatsApp only when nothing else reaches them)"]);
    const lone = await prisma.guest.create({ data: { name: "Phone Only Pari", phone: "9876543210" } });
    const both = await prisma.guest.create({ data: { name: "Mail Guest Mira", phone: "9876543211", email: "mira@example.com" } });
    for (const g of [lone, both]) await withTx((tx) => notifyGuest(tx, { event: "BOOKING_CANCELLED_BY_CLUB", guestId: g.id, title: "Session cancelled", body: "Sorry.", dedupeKey: `sa4:guest:${g.id}` }));
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: `sa4:guest:${lone.id}`, channel: "WHATSAPP_MANUAL" } })).status).toBe("QUEUED");
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: `sa4:guest:${both.id}`, channel: "WHATSAPP_MANUAL" } })).status).toBe("SKIPPED");
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_whatsapp_fallback", "ALWAYS"));
    await withTx((tx) => notifyMember(tx, dues(m, "sa4:always")));
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "sa4:always", channel: "WHATSAPP_MANUAL" } })).status).toBe("QUEUED");
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "manual_whatsapp_fallback", "NEVER"));
    const nobody = await person("Nobody Naveen");
    await withTx((tx) => notifyMember(tx, dues(nobody, "sa4:never")));
    const never = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "sa4:never", channel: "WHATSAPP_MANUAL" } });
    expect([never.status, never.error]).toEqual(["SKIPPED", expect.stringContaining("Manual WhatsApp is turned off")]);
  });
});

describe("v6 §2.3 — Send all", () => {
  it("SA-7: with the API on → sent through the approved template (official Cloud API only, SA-0), tasks SENT_AUTOMATICALLY and linked to their delivery rows; SA-11 the Message Log has the job id", async () => {
    const a = await person("Api Asha", { optIn: true });
    const b = await person("Api Bhanu", { optIn: true });
    const tA = await manualTask(a, "dues:apiA:1");
    const tB = await manualTask(b, "dues:apiB:1");
    await apiOn();
    meta("ok");
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    expect(res).toMatchObject({ created: true, job: { status: "QUEUED", total: 2, sent: 0, remaining: 2 } });
    expect(calls).toHaveLength(0); // the confirm returns at once; the worker sends
    await runSendAllJobs({ sleep });
    // SA-0: only the official WhatsApp Cloud API (Graph API) is called.
    expect(calls.map((c) => [new URL(c.url).host, c.template, c.to]).sort()).toEqual([
      ["graph.facebook.com", "dues_reminder", `91${a.member.phone}`], ["graph.facebook.com", "dues_reminder", `91${b.member.phone}`],
    ]);
    for (const t of [tA, tB]) {
      expect(await task(t.id)).toMatchObject({ status: "SENT_AUTOMATICALLY", handledBy: `sendall:${res.job.id}` });
      const sent = await prisma.notificationDelivery.findFirstOrThrow({ where: { taskId: t.id } });
      expect(sent).toMatchObject({ channel: "WHATSAPP_API", status: "SENT", bulkJobId: res.job.id, waTemplate: "dues_reminder", providerId: expect.stringMatching(/^wamid\.SA/) });
    }
    const p = await sendAllProgress(w.actors.FRONT_DESK, res.job.id);
    expect(p).toMatchObject({ status: "DONE", sent: 2, failed: 0, remaining: 0, perChannel: { WHATSAPP_API: { sent: 2, failed: 0, queued: 0 } } });
    const log = await prisma.messageLog.findMany({ where: { jobId: res.job.id } });
    expect(log.map((l) => [l.channel, l.status])).toEqual([["WHATSAPP", "SENT"], ["WHATSAPP", "SENT"]]);
    expect(await prisma.auditLog.count({ where: { action: { in: ["message.send_all", "message.send_all_done"] }, entityId: res.job.id } })).toBe(2);
  });

  it("SA-9: with the API off → only email and push are sent, WhatsApp is untouched; the button and preflight say so; Owner gets the setup link, the front desk is told to ask the owner", async () => {
    const e = await person("Mail Meera", { email: true });
    const p = await person("Push Pranav", { push: true });
    const x = await person("Phone Only Xavier");
    const tE = await manualTask(e, "dues:offE:1");
    const tP = await manualTask(p, "dues:offP:1");
    const tX = await manualTask(x, "dues:offX:1");
    meta("ok");
    const pre = await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES });
    expect(pre).toMatchObject({ whatsappApi: { on: false }, buttonLabel: "Send all by email & push", setupHref: null, willSend: { whatsapp: 0, email: 1, push: 1 } });
    expect(pre.cannot.reasons.map((r) => r.reason)).toContain("WhatsApp API not set up");
    expect((await sendAllPreflight(w.actors.OWNER, { filter: DUES })).setupHref).toBe("/app/settings?tab=whatsapp");
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    await runSendAllJobs({ sleep });
    expect(calls).toHaveLength(0);
    expect(await prisma.notificationDelivery.count({ where: { bulkJobId: res.job.id, channel: "WHATSAPP_API" } })).toBe(0);
    expect(mails.map((m) => [m.to, m.subject])).toEqual([[e.member.email, "₹400 due"]]);
    expect(mails[0].text).toContain(`${process.env.APP_URL}/portal/payments`);
    expect(pushes.map((x) => x.payload.title)).toEqual(["₹400 due"]);
    expect((await task(tE.id)).status).toBe("SENT_AUTOMATICALLY");
    expect((await task(tP.id)).status).toBe("SENT_AUTOMATICALLY");
    expect(await task(tX.id)).toMatchObject({ status: "QUEUED", handledBy: null }); // can't go automatically: stays for the desk
    const log = await prisma.messageLog.findMany({ where: { jobId: res.job.id }, orderBy: { channel: "asc" } });
    expect(log.map((l) => [l.channel, l.status])).toEqual([["EMAIL", "SENT"], ["PUSH", "SENT"]]);
  });

  it("SA-7: email at most one per second (the shared rate gate); a failure stays in the queue with its reason; SA-11 the Message Log has the error and the job id", async () => {
    const people = [await person("Rate One", { email: true }), await person("Rate Two", { email: true }), await person("Rate Three", { email: true })];
    const tasks = [];
    for (const [i, m] of people.entries()) tasks.push(await manualTask(m, `dues:rate${i}:1`));
    const sentAt: number[] = [];
    setMailTransportForTests({
      sendMail: async (m) => {
        if ((m as Mail).to === people[2].member.email) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
        sentAt.push(clock.now().getTime());
        mails.push(m as unknown as Mail);
      },
    });
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    await runSendAllJobs({ sleep });
    expect(sentAt).toHaveLength(2);
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(1000);
    const failed = await task(tasks[2].id);
    expect([failed.status, failed.handledBy]).toEqual(["QUEUED", null]);
    expect(failed.error).toMatch(/^Send all: Email: 550 mailbox unavailable/);
    const p = await sendAllProgress(w.actors.FRONT_DESK, res.job.id);
    expect(p).toMatchObject({ status: "DONE", sent: 2, failed: 1, remaining: 0 });
    expect(p.failures).toEqual([{ taskId: tasks[2].id, name: "Rate Three", reason: expect.stringContaining("550 mailbox unavailable") }]);
    const bad = await prisma.messageLog.findFirstOrThrow({ where: { jobId: res.job.id, status: "FAILED" } });
    expect([bad.channel, bad.error]).toEqual(["EMAIL", "550 mailbox unavailable"]);
  });

  it("SA-7: a WhatsApp rate limit pauses the job and it resumes by itself when the pause is over", async () => {
    const a = await person("Pause Pia", { optIn: true });
    const b = await person("Pause Qadir", { optIn: true });
    const tA = await manualTask(a, "dues:pauseA:1");
    const tB = await manualTask(b, "dues:pauseB:1");
    await apiOn();
    meta({ status: 429, body: { error: { code: 130429, message: "Rate limit hit" } } }, "ok");
    const res = await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    await runSendAllJobs({ sleep });
    let p = await sendAllProgress(w.actors.FRONT_DESK, res.job.id);
    expect(p).toMatchObject({ status: "RUNNING", sent: 0, remaining: 2, waiting: 1, pausedUntil: expect.any(String) });
    expect(calls).toHaveLength(1); // the second one waits for the pause
    expect((await task(tA.id)).status).toBe("QUEUED");
    clock.set(new Date(new Date(p.pausedUntil!).getTime() + 1000));
    await runSendAllJobs({ sleep });
    p = await sendAllProgress(w.actors.FRONT_DESK, res.job.id);
    expect(p).toMatchObject({ status: "DONE", sent: 2, failed: 0, remaining: 0, pausedUntil: null });
    expect([(await task(tA.id)).status, (await task(tB.id)).status]).toEqual(["SENT_AUTOMATICALLY", "SENT_AUTOMATICALLY"]);
    expect(calls).toHaveLength(3);
  });

  it("SA-8: a double click creates one job (the second click gets the running job); a new job once it is done", async () => {
    const m = await person("Click Kavya", { email: true });
    await manualTask(m, "dues:click:1");
    const [one, two] = await Promise.all([startSendAll(w.actors.FRONT_DESK, { filter: DUES }), startSendAll(w.actors.FRONT_DESK, { filter: DUES })]);
    expect(one.job.id).toBe(two.job.id);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    // The same filter written differently is the same queue filter.
    const third = await startSendAll(w.actors.MANAGER, { filter: `page=2&${DUES}&size=50` });
    expect([third.created, third.job.id]).toEqual([false, one.job.id]);
    expect((await sendAllPreflight(w.actors.FRONT_DESK, { filter: DUES })).runningJob?.id).toBe(one.job.id);
    expect(await prisma.bulkSendJob.count()).toBe(1);
    await runSendAllJobs({ sleep });
    await manualTask(m, "dues:click2:1");
    expect((await startSendAll(w.actors.FRONT_DESK, { filter: DUES })).created).toBe(true);
    expect(await prisma.bulkSendJob.count()).toBe(2);
  });

  it("SA-10: the front desk sends TRANSACTIONAL tasks only — announcements need a Manager or the Owner; other roles can't Send all", async () => {
    const people = [await person("Ann One", { email: true }), await person("Ann Two", { email: true })];
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key: "friday_social" } });
    await createBulkSend(w.actors.MANAGER, { templateId: t.id, list: "members", ids: people.map((p) => p.memberId), channels: ["WHATSAPP"] });
    const filter = "type=TEMPLATE_MESSAGE";
    const fd = await sendAllPreflight(w.actors.FRONT_DESK, { filter });
    expect([fd.excludedAnnouncements, fd.willSend.tasks]).toEqual([2, 0]);
    const mgr = await sendAllPreflight(w.actors.MANAGER, { filter });
    expect([mgr.excludedAnnouncements, mgr.willSend.email]).toEqual([0, 2]);
    expect(await err(sendAllPreflight(w.actors.BAR_STAFF, { filter }))).toMatchObject({ code: "FORBIDDEN" });
    const res = await startSendAll(w.actors.MANAGER, { filter });
    await runSendAllJobs({ sleep });
    expect(await sendAllProgress(w.actors.MANAGER, res.job.id)).toMatchObject({ status: "DONE", sent: 2 });
    expect(mails.map((m) => m.to).sort()).toEqual(people.map((p) => p.member.email).sort());
  });
});

describe("v6 §1 URL-3 — render at send time", () => {
  it("URL-3: a task stores the event + variables (not only the text); opening it and sending it by email pick up a changed APP_URL; a row from before v6 keeps its stored text", async () => {
    const m = await person("Link Lina", { email: true });
    const before = process.env.APP_URL!;
    const t = await manualTask(m, "dues:url3:1");
    expect(t.whatsappText).toContain(`${before}/portal/payments`);
    expect(t.renderSpec).toMatchObject({ v: 1, kind: "EVENT", link: "/portal/payments", body: "Please pay at the club. Details: {{app.url}}/portal/payments" });
    expect(t.contextIds).toEqual({ billId: "url3" });
    process.env.APP_URL = "https://champions.example.org";
    const { url } = await openManualMessage(w.actors.FRONT_DESK, t.id);
    const text = decodeURIComponent(url.split("?text=")[1]);
    expect(text).toBe("₹400 due\nPlease pay at the club. Details: https://champions.example.org/portal/payments\nhttps://champions.example.org/portal/payments");
    expect(text).not.toContain(before);
    // Sent by a job (email instead): rendered then, with the new address.
    const t2 = await manualTask(m, "dues:url3b:1");
    process.env.APP_URL = "https://club.example.net";
    await startSendAll(w.actors.FRONT_DESK, { filter: DUES });
    await runSendAllJobs({ sleep });
    const mail = mails.find((x) => x.to === m.member.email)!;
    expect(mail.text).toContain("https://club.example.net/portal/payments");
    expect(mail.text).not.toContain("champions.example.org");
    expect((await task(t2.id)).status).toBe("SENT_AUTOMATICALLY");
    // v5 template messages: template id + version + variables, rendered when opened.
    const tpl = await prisma.messageTemplate.findUniqueOrThrow({ where: { key: "membership_expiring" } });
    const o = await person("Template Tanvi");
    await createBulkSend(w.actors.FRONT_DESK, { templateId: tpl.id, list: "renewals", ids: [o.memberId], channels: ["WHATSAPP"] });
    const tt = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: o.memberId, channel: "WHATSAPP_MANUAL", templateId: tpl.id } });
    expect(tt.renderSpec).toMatchObject({ kind: "TEMPLATE", templateId: tpl.id, version: tpl.version, recordId: o.memberId, values: { link: "{{app.url}}/portal/membership" } });
    process.env.APP_URL = "https://third.example.com";
    const opened = decodeURIComponent((await openManualMessage(w.actors.FRONT_DESK, tt.id)).url.split("?text=")[1]);
    expect(opened).toContain("https://third.example.com/portal/membership");
    // A row made before v6 (no render spec) keeps its stored text.
    const legacy = await manualTask(m, "dues:legacy:1");
    await prisma.$executeRaw`UPDATE notification_deliveries SET render_spec = NULL, whatsapp_text = 'Old text https://old.trycloudflare.com/portal' WHERE id = ${legacy.id}`;
    expect(decodeURIComponent((await openManualMessage(w.actors.FRONT_DESK, legacy.id)).url.split("?text=")[1])).toBe("Old text https://old.trycloudflare.com/portal");
  });

  it("SA-0: no WhatsApp Web / Desktop automation or unofficial WhatsApp library is a dependency", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ["whatsapp-web.js", "@whiskeysockets/baileys", "baileys", "venom-bot", "@open-wa/wa-automate", "wppconnect", "@wppconnect-team/wppconnect", "whatsapp-web"]) {
      expect(deps).not.toContain(banned);
    }
  });
});
