// v4 §5 (WHATSAPP): Settings → WhatsApp and the `whatsapp.api` capability, opt-in, the template values events pass,
// the webhook (verification, signature, delivery statuses, STOP, replies) and the signed `/r/<token>` page.
// Outbound HTTP to Meta is mocked; the database is real.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { resetRateLimits } from "@/server/rate-limit";
import { cancelBooking } from "@/server/services/booking";
import { getCapabilities, invalidateCapabilities } from "@/server/services/capabilities";
import { memberAudience, notifyMember, openManualMessage } from "@/server/services/channels";
import { closeCourts } from "@/server/services/closures";
import { createEnquiry, createTrialBooking } from "@/server/services/crm";
import { createMember } from "@/server/services/membership";
import { createSocialSession, joinSession } from "@/server/services/social";
import { inspectResolutionToken, signResolutionToken, verifyResolutionToken } from "@/server/services/signed-links";
import { sendTemplateMessage, setWhatsAppFetchForTests } from "@/server/services/whatsapp/client";
import { templateFor, whatsappOptedIn, whatsappReady } from "@/server/services/whatsapp/config";
import { myWhatsappOptIn, setMyWhatsappOptIn } from "@/server/services/whatsapp/opt-in";
import { resolveByLink, viewResolution } from "@/server/services/whatsapp/resolution";
import { checkWhatsappToken, fetchWhatsappTemplates, saveTemplateMapping, sendWhatsappTestMessage, whatsappSetupStatus } from "@/server/services/whatsapp/setup";
import { WA_TEMPLATE_NAMES } from "@/server/services/whatsapp/templates";
import { handleWebhook, verifyWebhookSubscription } from "@/server/services/whatsapp/webhook";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book } from "../helpers/booking";

const PHONE_ID = "1098765432";
const WABA = "2233445566";
const SECRET = "test-wa-app-secret";
const VERIFY = "test-verify-token-xyz";
const TOKEN = "EAAtest-access-token-do-not-log";
const ENV: Record<string, string> = {
  WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, WHATSAPP_BUSINESS_ACCOUNT_ID: WABA,
  WHATSAPP_APP_SECRET: SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY, WHATSAPP_GRAPH_API_VERSION: "v23.0",
};

let w: World;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let wamidSeq = 0;
let sendReply: () => { status: number; body: unknown } = () => ({ status: 200, body: { messaging_product: "whatsapp", messages: [{ id: `wamid.T${++wamidSeq}` }] } });
let tokenReply: () => { status: number; body: unknown } = () => ({ status: 200, body: { display_phone_number: "+91 79 4000 0000", verified_name: "The Champions Club", id: PHONE_ID } });
let metaTemplates: Array<{ name: string; language: string; status: string; category: string }> = [];

function installFetch() {
  setWhatsAppFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const reply = method === "POST" && u.endsWith(`/${PHONE_ID}/messages`) ? sendReply()
      : u.includes(`/${WABA}/message_templates`) ? { status: 200, body: { data: metaTemplates, paging: {} } }
        : u.includes(`/${PHONE_ID}?fields=`) ? tokenReply()
          : { status: 404, body: { error: { message: "unknown", code: 803 } } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
}
const sends = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));

function setEnv(on: boolean) {
  for (const [k, v] of Object.entries(ENV)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
  invalidateCapabilities();
}

/** The real setup path: token check, mapping, "Fetch templates" (all APPROVED), test message. */
async function enableWhatsApp(statuses: Partial<Record<string, string>> = {}) {
  setEnv(true);
  installFetch();
  await checkWhatsappToken(w.actors.OWNER);
  await saveTemplateMapping(w.actors.OWNER, { templates: Object.fromEntries(WA_TEMPLATE_NAMES.map((n) => [n, { name: `cc_${n}`, language: "en" }])) });
  metaTemplates = WA_TEMPLATE_NAMES.map((n) => ({ name: `cc_${n}`, language: "en", status: statuses[n] ?? "APPROVED", category: "UTILITY" }));
  await fetchWhatsappTemplates(w.actors.OWNER);
  await sendWhatsappTestMessage(w.actors.OWNER, { to: "98765 00000" });
  calls = [];
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const ts = (d: Date = clock.now()) => String(Math.floor(d.getTime() / 1000));
const envelope = (value: Record<string, unknown>) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "917940000000", phone_number_id: PHONE_ID }, ...value } }] }] });
const statusBody = (wamid: string, status: string, extra: Record<string, unknown> = {}) => envelope({ statuses: [{ id: wamid, status, timestamp: ts(), recipient_id: "919000000000", ...extra }] });
const inboundBody = (id: string, from: string, text: string, name = "Rain Riya") =>
  envelope({ contacts: [{ wa_id: from, profile: { name } }], messages: [{ id, from, timestamp: ts(), type: "text", text: { body: text } }] });
const hook = (body: string) => handleWebhook(body, sign(body));

const wet = (over: Partial<{ start: string; end: string; date: string; court: string }> = {}) => ({
  courtIds: [w.courts[over.court ?? "Court 1"].id], date: over.date ?? "2026-10-12", startTime: over.start ?? "17:00", endTime: over.end ?? "21:00", reason: "WET_COURT" as const, note: "Rain overnight",
});

async function optedInMember(name: string) {
  const m = await makeMember(w, { name, plan: "SILVER" });
  await setMyWhatsappOptIn(m.actor, { optIn: true });
  return m;
}

beforeEach(async () => {
  w = await makeWorld();
  calls = [];
  metaTemplates = [];
  resetRateLimits();
  sendReply = () => ({ status: 200, body: { messaging_product: "whatsapp", messages: [{ id: `wamid.T${++wamidSeq}` }] } });
  tokenReply = () => ({ status: 200, body: { display_phone_number: "+91 79 4000 0000", verified_name: "The Champions Club", id: PHONE_ID } });
});
afterEach(async () => {
  await settleAfterCommit();
  setWhatsAppFetchForTests(null);
  setEnv(false);
});

describe("WA-14…WA-19 — Settings → WhatsApp and the whatsapp.api capability (§5.1)", () => {
  it("WA-14: on only with every env variable + a passing token check + a successful test message", async () => {
    let caps = await getCapabilities();
    expect(caps["whatsapp.api"].enabled).toBe(false);
    expect(caps["whatsapp.api"].reason).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(caps["whatsapp.api"].reason).toContain("WHATSAPP_GRAPH_API_VERSION");
    expect(await whatsappReady()).toBe(false);

    setEnv(true);
    installFetch();
    caps = await getCapabilities();
    expect(caps["whatsapp.api"]).toMatchObject({ enabled: false, reason: expect.stringMatching(/access token/) });

    // WA-16: Meta rejects the token → stays off, with Meta's reason.
    tokenReply = () => ({ status: 401, body: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } } });
    expect(await checkWhatsappToken(w.actors.OWNER)).toMatchObject({ ok: false, reason: expect.stringContaining("#190") });
    expect((await getCapabilities())["whatsapp.api"]).toMatchObject({ enabled: false, reason: expect.stringMatching(/rejected the access token/) });
    // A network failure changes nothing.
    tokenReply = () => { throw new Error("unreachable"); };
    setWhatsAppFetchForTests((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    await expect(checkWhatsappToken(w.actors.OWNER)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    installFetch();
    tokenReply = () => ({ status: 200, body: { display_phone_number: "+91 79 4000 0000", verified_name: "The Champions Club" } });
    expect(await checkWhatsappToken(w.actors.OWNER)).toMatchObject({ ok: true, phone: "The Champions Club · +91 79 4000 0000" });
    expect((await getCapabilities())["whatsapp.api"]).toMatchObject({ enabled: false, reason: expect.stringMatching(/test message/) });

    // WA-19: the test message — a bad number is refused before any request; a failure says why and switches nothing.
    await expect(sendWhatsappTestMessage(w.actors.OWNER, { to: "12345 67890" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    sendReply = () => ({ status: 400, body: { error: { message: "Template name does not exist in the translation", code: 132001 } } });
    await expect(sendWhatsappTestMessage(w.actors.OWNER, { to: "9876500000", template: "no_such_template" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("#132001") });
    expect((await getCapabilities())["whatsapp.api"].enabled).toBe(false);
    sendReply = () => ({ status: 200, body: { messages: [{ id: "wamid.TEST" }] } });
    expect(await sendWhatsappTestMessage(w.actors.OWNER, { to: "98765 00000" })).toMatchObject({ ok: true, to: "919876500000", wamid: "wamid.TEST" });
    const test = sends().at(-1)!;
    expect(test.body).toMatchObject({ to: "919876500000", type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
    expect((await getCapabilities())["whatsapp.api"].enabled).toBe(true);
    expect(await whatsappReady()).toBe(true);

    // Any env variable missing → off again.
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    invalidateCapabilities();
    expect((await getCapabilities())["whatsapp.api"]).toMatchObject({ enabled: false, reason: expect.stringContaining("WHATSAPP_WEBHOOK_VERIFY_TOKEN") });
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY;
    invalidateCapabilities();
    expect(await whatsappReady()).toBe(true);

    // Meta revokes the token later: the first send that gets #190 switches the capability off.
    sendReply = () => ({ status: 401, body: { error: { message: "Error validating access token", code: 190 } } });
    expect(await sendTemplateMessage({ to: "919876500000", template: "cc_refund_completed", language: "en", params: ["A", "1", "x", "RF-1"], buttonParam: null })).toMatchObject({ ok: false, kind: "PERMANENT", code: 190 });
    expect((await getCapabilities())["whatsapp.api"]).toMatchObject({ enabled: false, reason: expect.stringMatching(/rejected the access token/) });
  });

  it("WA-15/WA-17/WA-18: a template is used only when mapped and APPROVED; Fetch templates stores Meta's status per mapping", async () => {
    setEnv(true);
    installFetch();
    expect(await withTx((tx) => templateFor(tx, "club_session_cancelled"))).toBeNull();
    await saveTemplateMapping(w.actors.OWNER, { templates: { club_session_cancelled: { name: "cc_cancel", language: "en" }, refund_completed: { name: "cc_refund_done", language: "en" }, refund_rejected: { name: "cc_refund_no", language: "en" }, booking_rescheduled: { name: "cc_moved", language: "en_US" }, dues_reminder: { name: "cc_dues", language: "en" } } });
    expect(await withTx((tx) => templateFor(tx, "club_session_cancelled"))).toEqual({ name: "cc_cancel", language: "en", approved: false });
    metaTemplates = [
      { name: "cc_cancel", language: "en", status: "APPROVED", category: "UTILITY" },
      { name: "cc_refund_done", language: "en", status: "PENDING", category: "UTILITY" },
      { name: "cc_refund_no", language: "en", status: "REJECTED", category: "UTILITY" },
      { name: "cc_moved", language: "en", status: "APPROVED", category: "UTILITY" }, // other language than mapped
      { name: "cc_dues", language: "en", status: "PAUSED", category: "UTILITY" },
    ];
    const r = await fetchWhatsappTemplates(w.actors.OWNER);
    expect(calls.find((c) => c.url.includes("message_templates"))!.url).toBe(`https://graph.facebook.com/v23.0/${WABA}/message_templates?fields=name,language,status,category&limit=200`);
    expect(Object.fromEntries(Object.entries(r.mapped).map(([k, v]) => [k, v!.status]))).toEqual({
      club_session_cancelled: "APPROVED", refund_completed: "PENDING", refund_rejected: "REJECTED", booking_rescheduled: "NOT_FOUND", dues_reminder: "PAUSED",
    });
    const approved = async (n: Parameters<typeof templateFor>[1]) => (await withTx((tx) => templateFor(tx, n)))?.approved ?? null;
    expect(await approved("club_session_cancelled")).toBe(true);
    expect(await approved("refund_completed")).toBe(false);
    expect(await approved("refund_rejected")).toBe(false);
    expect(await approved("booking_rescheduled")).toBe(false);
    expect(await approved("dues_reminder")).toBe(false);
    expect(await approved("refund_unclaimed_reminder")).toBeNull();
    // Changing a mapping forgets Meta's old status until the next fetch; an unchanged one keeps it; empty unmaps.
    await saveTemplateMapping(w.actors.OWNER, { templates: { club_session_cancelled: { name: "cc_cancel", language: "en" }, refund_completed: { name: "cc_refund_done2", language: "en" }, dues_reminder: { name: "", language: "en" } } });
    expect(await approved("club_session_cancelled")).toBe(true);
    expect(await withTx((tx) => templateFor(tx, "refund_completed"))).toEqual({ name: "cc_refund_done2", language: "en", approved: false });
    expect(await approved("dues_reminder")).toBeNull();
    await expect(saveTemplateMapping(w.actors.OWNER, { templates: { club_session_cancelled: { name: "Bad Name!", language: "en" } } })).rejects.toThrow();
  });

  it("Owner only; the status page shows which env variables are set, never their values", async () => {
    await expect(whatsappSetupStatus(w.actors.MANAGER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkWhatsappToken(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveTemplateMapping(w.actors.MANAGER, { templates: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sendWhatsappTestMessage(w.actors.FRONT_DESK, { to: "9876500000" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    let s = await whatsappSetupStatus(w.actors.OWNER);
    expect(s.envOk).toBe(false);
    expect(s.capability.enabled).toBe(false);
    // Without keys nothing can be checked or sent; the app keeps working without WhatsApp.
    await expect(checkWhatsappToken(w.actors.OWNER)).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await expect(fetchWhatsappTemplates(w.actors.OWNER)).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await expect(sendWhatsappTestMessage(w.actors.OWNER, { to: "9876500000" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await enableWhatsApp();
    s = await whatsappSetupStatus(w.actors.OWNER);
    expect(s.env.every((e) => e.set)).toBe(true);
    expect(s.token.ok).toBe(true);
    expect(s.testSentAt).not.toBeNull();
    expect(s.webhook.url).toBe(`${process.env.APP_URL}/api/whatsapp/webhook`);
    expect(s.templates.every((t) => t.status === "APPROVED")).toBe(true);
    const json = JSON.stringify(s);
    for (const v of [TOKEN, SECRET, VERIFY]) expect(json).not.toContain(v);
    expect(await prisma.auditLog.count({ where: { action: { in: ["whatsapp.token_check", "whatsapp.test_message"] } } })).toBeGreaterThanOrEqual(2);
  });
});

describe("WA-30…WA-32 — opt-in (§5.1)", () => {
  it("WA-30: the sign-up, enquiry and trial forms store the separate WhatsApp tick with a timestamp; whatsappOptedIn reads it", async () => {
    const yes = await createMember(w.actors.FRONT_DESK, { name: "Opted Omkar", phone: "9811100001", dob: "1990-01-01", consent: true, whatsappOptIn: true });
    const no = await createMember(w.actors.FRONT_DESK, { name: "Quiet Qadir", phone: "9811100002", dob: "1990-01-01", consent: true });
    const [my, mn] = await Promise.all([prisma.member.findUniqueOrThrow({ where: { id: yes.memberId } }), prisma.member.findUniqueOrThrow({ where: { id: no.memberId } })]);
    expect(my.whatsappOptInAt?.toISOString()).toBe(clock.now().toISOString());
    expect(mn.whatsappOptInAt).toBeNull();
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: my.userId }))).toBe(true);
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: mn.userId }))).toBe(false);
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: w.actors.FRONT_DESK.userId }))).toBe(false); // staff: no member, no consent
    expect(await withTx((tx) => whatsappOptedIn(tx, {}))).toBe(false);

    const e1 = await createEnquiry({ name: "Enquiring Esha", phone: "9811100003", interest: "Tennis", message: "Coaching?", consent: true, whatsappOptIn: true });
    const e2 = await createEnquiry({ name: "Silent Sunil", phone: "9811100004", interest: "Tennis", message: "", consent: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { code: e1.leadCode } })).whatsappOptInAt).not.toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { code: e2.leadCode } })).whatsappOptInAt).toBeNull();

    const t = await createTrialBooking({ name: "Trial Tara", phone: "9811100005", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "15:00", consent: true, whatsappOptIn: true });
    const g = await prisma.guest.findUniqueOrThrow({ where: { phone: "9811100005" } });
    expect(g.whatsappOptInAt).not.toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { code: t.leadCode } })).whatsappOptInAt).not.toBeNull();
    expect(await withTx((tx) => whatsappOptedIn(tx, { guestId: g.id }))).toBe(true);
    await createTrialBooking({ name: "Trial Tanvi", phone: "9811100006", courtId: w.courts["Court 4"].id, date: "2026-10-12", startTime: "15:00", consent: true });
    const g2 = await prisma.guest.findUniqueOrThrow({ where: { phone: "9811100006" } });
    expect(await withTx((tx) => whatsappOptedIn(tx, { guestId: g2.id }))).toBe(false);
  });

  it("WA-31: an existing member opts in and out in the portal (audited); staff can't use the member toggle", async () => {
    const m = await makeMember(w, { name: "Portal Priya", plan: "SILVER" });
    expect(await myWhatsappOptIn(m.actor)).toMatchObject({ optedIn: false, optInAt: null, automatic: false });
    clock.set(new Date(clock.now().getTime() + 60_000));
    expect(await setMyWhatsappOptIn(m.actor, { optIn: true })).toMatchObject({ optedIn: true });
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: m.member.userId }))).toBe(true);
    clock.set(new Date(clock.now().getTime() + 60_000));
    expect(await setMyWhatsappOptIn(m.actor, { optIn: false })).toMatchObject({ optedIn: false });
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: m.member.userId }))).toBe(false);
    expect((await prisma.auditLog.findMany({ where: { entityId: m.memberId, action: { startsWith: "whatsapp.opt_" } }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["whatsapp.opt_in", "whatsapp.opt_out"]);
    await expect(setMyWhatsappOptIn(w.actors.FRONT_DESK, { optIn: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("WA-32: messages about a Junior go to the guardian, whose own consent applies", async () => {
    const parent = await makeMember(w, { name: "Guardian Gita", plan: "SILVER" });
    const junior = await createMember(w.actors.FRONT_DESK, { name: "Junior Jai", phone: "9811100010", dob: "2014-06-01", consent: true, whatsappOptIn: true, guardianName: "Guardian Gita", guardianPhone: parent.member.phone });
    const audience = await withTx((tx) => memberAudience(tx, [junior.memberId]));
    const guardianRow = audience.find((a) => a.userId === parent.member.userId)!;
    expect(guardianRow.memberId).toBe(junior.memberId);
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: guardianRow.userId }))).toBe(false);
    await setMyWhatsappOptIn(parent.actor, { optIn: true });
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: guardianRow.userId }))).toBe(true);
    expect((await myWhatsappOptIn(parent.actor)).juniors).toBe(1);
  });
});

describe("§5.2 emitters — events pass their WhatsApp template values; sent after commit", () => {
  it("club cancellation → club_session_cancelled to the opted-in booker, button = signed /r token; not to a member who did not opt in", async () => {
    await enableWhatsApp();
    const m = await optedInMember("Rain Riya");
    const quiet = await makeMember(w, { name: "Quiet Quinn", plan: "SILVER" });
    const b1 = await book(w, { time: "18:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await book(w, { time: "19:00", players: [{ memberId: quiet.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b1.bookingId } });
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API" } });
    expect(row.status).toBe("SENT");
    expect(row.providerId).toMatch(/^wamid\.T\d+$/);
    expect(row.toAddress).toBe(`91${m.member.phone}`);
    const sent = sends();
    expect(sent).toHaveLength(1);
    const tpl = sent[0].body!.template as { name: string; language: { code: string }; components: Array<{ type: string; parameters: Array<{ text: string }>; sub_type?: string; index?: string }> };
    expect(tpl.name).toBe("cc_club_session_cancelled");
    expect(tpl.components[0].parameters.map((p) => p.text)).toEqual(["Rain", "Tennis (Court 1)", "Mon, 12 Oct 2026", "6:00 pm", "Wet court: Rain overnight", "150", expect.stringMatching(/^Mon, 19 Oct, 10:00 am$/)]);
    expect(tpl.components[1]).toMatchObject({ type: "button", sub_type: "url", index: "0" });
    const token = tpl.components[1].parameters[0].text;
    expect(verifyResolutionToken(token)).toEqual({ clubCancellationId: cc.id });
    expect(inspectResolutionToken(token)!.expiresAt.getTime()).toBe(Math.floor(cc.deadlineAt.getTime() / 1000) * 1000);
    // No consent → no automatic WhatsApp; the desk's manual task carries the message instead.
    const q = await prisma.notificationDelivery.findMany({ where: { memberId: quiet.memberId, event: "BOOKING_CANCELLED_BY_CLUB" } });
    expect(Object.fromEntries(q.map((d) => [d.channel, [d.status, d.error]]))).toMatchObject({ WHATSAPP_API: ["SKIPPED", "Not opted in to WhatsApp updates"], WHATSAPP_MANUAL: ["QUEUED", null] });
  });

  it("WA-50: closing courts queues one WhatsApp per opted-in affected person — the choice (with /r) only to the booker", async () => {
    await enableWhatsApp();
    const booker = await optedInMember("Booker Bela");
    const player = await optedInMember("Player Pranav");
    const unpaid = await optedInMember("Unpaid Uma");
    const social = await optedInMember("Social Sana");
    await createTrialBooking({ name: "Trial Tara", phone: "9811100050", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "15:00", consent: true, whatsappOptIn: true });
    const g = await prisma.guest.findUniqueOrThrow({ where: { phone: "9811100050" } });
    const paid = await book(w, { time: "18:00", players: [{ memberId: booker.memberId }, { memberId: player.memberId }, { guestId: g.id }], payment: { kind: "COUNTER", method: "CASH" } });
    const owed = await book(w, { time: "19:00", players: [{ memberId: unpaid.memberId }] });
    const sessions = await createSocialSession(w.actors.MANAGER, { title: "Evening social", date: "2026-10-12", startTime: "20:00", endTime: "21:00", courtIds: [w.courts["Court 1"].id], capacityPerCourt: 8 });
    await joinSession(w.actors.FRONT_DESK, { sessionId: sessions.sessions[0].id, player: { memberId: social.memberId }, payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    type Tpl = { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
    const byTo = Object.fromEntries(sends().map((c) => [c.body!.to as string, c.body!.template as Tpl]));
    expect(Object.keys(byTo).sort()).toEqual([booker, player, unpaid, social].map((m) => `91${m.member.phone}`).concat("919811100050").sort());
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: paid.bookingId } });
    // The booker chooses: club_session_cancelled with the signed link.
    const b = byTo[`91${booker.member.phone}`];
    expect(b.name).toBe("cc_club_session_cancelled");
    expect(verifyResolutionToken(b.components[1].parameters[0].text)).toEqual({ clubCancellationId: cc.id });
    // The other players (member and guest) are told, without the booker's link.
    for (const to of [`91${player.member.phone}`, "919811100050"]) {
      expect(byTo[to].name).toBe("cc_booking_cancelled_refund");
      expect(byTo[to].components[0].parameters.map((p) => p.text)).toEqual([expect.any(String), paid.bookingCode, "Mon, 12 Oct 2026", "6:00 pm", "the person who booked chooses a new time or a refund"]);
      expect(byTo[to].components[1].parameters[0].text).toBe(paid.bookingCode);
    }
    expect(byTo["919811100050"].components[0].parameters[0].text).toBe("Trial");
    // Nothing was paid: no choice, just the cancellation.
    expect(byTo[`91${unpaid.member.phone}`].components[0].parameters.map((p) => p.text)).toEqual(["Unpaid", owed.bookingCode, "Mon, 12 Oct 2026", "7:00 pm", "nothing was charged"]);
    // Social play on the closed court: the refund outcome.
    expect(byTo[`91${social.member.phone}`].name).toBe("cc_booking_cancelled_refund");
    expect(byTo[`91${social.member.phone}`].components[0].parameters[1].text).toBe("Evening social");
    expect(await prisma.notificationDelivery.count({ where: { event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API", status: "SENT" } })).toBe(5);
  });

  it("staff cancellation and social cancellation → booking_cancelled_refund with the refund outcome; button = refund code", async () => {
    await enableWhatsApp();
    const m = await optedInMember("Cancel Chirag");
    const b = await book(w, { court: "Court 2", time: "18:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await cancelBooking(w.actors.FRONT_DESK, b.bookingId, { reason: "Coach unwell" });
    await settleAfterCommit();
    const req = await prisma.refundRequest.findFirstOrThrow({ where: { billId: b.billId! } });
    const tpl = sends()[0].body!.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
    expect(tpl.name).toBe("cc_booking_cancelled_refund");
    expect(tpl.components[0].parameters.map((p) => p.text)).toEqual(["Cancel", b.bookingCode, "Mon, 12 Oct 2026", "6:00 pm", "₹150 refunded"]);
    expect(tpl.components[1].parameters[0].text).toBe(req.code);

    calls = [];
    const sessions = await createSocialSession(w.actors.MANAGER, { title: "Evening social", date: "2026-10-12", startTime: "20:00", endTime: "21:00", courtIds: [w.courts["Court 1"].id], capacityPerCourt: 8 });
    await joinSession(w.actors.FRONT_DESK, { sessionId: sessions.sessions[0].id, player: { memberId: m.memberId }, payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    const social = sends().map((c) => c.body!.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> });
    expect(social).toHaveLength(1);
    expect(social[0].name).toBe("cc_booking_cancelled_refund");
    expect(social[0].components[0].parameters.map((p) => p.text).slice(0, 4)).toEqual(["Cancel", "Evening social", "Mon, 12 Oct 2026", "8:00 pm"]);
  });

  it("nothing is sent while the template is not APPROVED (PENDING): the event falls back to the manual task", async () => {
    await enableWhatsApp({ club_session_cancelled: "PENDING" });
    const m = await optedInMember("Pending Pooja");
    await book(w, { time: "18:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    expect(sends()).toHaveLength(0);
    const rows = await prisma.notificationDelivery.findMany({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED_BY_CLUB" } });
    expect(Object.fromEntries(rows.map((d) => [d.channel, d.status]))).toMatchObject({ WHATSAPP_API: "SKIPPED", WHATSAPP_MANUAL: "QUEUED" });
  });
});

describe("WA-40…WA-44 — the webhook (§5.4 step 6)", () => {
  it("WA-40: GET echoes hub.challenge only for the right verify token, and records the verification", async () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o);
    await expect(verifyWebhookSubscription(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" }))).rejects.toMatchObject({ code: "FORBIDDEN" }); // no env
    setEnv(true);
    await expect(verifyWebhookSubscription(q({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(verifyWebhookSubscription(q({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await whatsappSetupStatus(w.actors.OWNER)).webhook.verifiedAt).toBeNull();
    expect(await verifyWebhookSubscription(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" }))).toBe("1158201444");
    expect((await whatsappSetupStatus(w.actors.OWNER)).webhook.verifiedAt).toBe(clock.now().toISOString());
  });

  it("WA-41: POST is accepted only with X-Hub-Signature-256 over the raw body with the app secret", async () => {
    const body = statusBody("wamid.none", "delivered");
    await expect(handleWebhook(body, sign(body))).rejects.toMatchObject({ code: "FORBIDDEN" }); // no secret configured
    setEnv(true);
    await expect(handleWebhook(body, null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handleWebhook(body, "sha256=00")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handleWebhook(body, sign(body, "another-secret"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handleWebhook(body.replace("delivered", "read"), sign(body))).rejects.toMatchObject({ code: "FORBIDDEN" }); // tampered
    await expect(handleWebhook(body, sign(body).replace("sha256=", "sha1="))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await handleWebhook(body, sign(body))).toEqual({ statuses: 0, inbound: 0 }); // unknown wamid: ignored
    expect(await handleWebhook(body, sign(body).toUpperCase().replace("SHA256=", "sha256="))).toEqual({ statuses: 0, inbound: 0 });
    // A signed POST also proves the webhook works.
    expect((await whatsappSetupStatus(w.actors.OWNER)).webhook.verifiedAt).not.toBeNull();
  });

  it("WA-42: sent → delivered → read with timestamps; never backwards; repeats change nothing; failed → FAILED + manual fallback", async () => {
    await enableWhatsApp();
    const m = await optedInMember("Status Sunita");
    const b1 = await book(w, { time: "18:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const m2 = await optedInMember("Failed Firoz");
    await book(w, { time: "19:00", players: [{ memberId: m2.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    const row = () => prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API" } });
    const wamid = (await row()).providerId!;
    expect(b1.bookingId).toBeTruthy();

    const t1 = clock.now();
    expect(await hook(statusBody(wamid, "sent"))).toEqual({ statuses: 1, inbound: 0 });
    expect(await row()).toMatchObject({ status: "SENT", waStatus: "sent", waSentAt: t1 });
    clock.set(new Date(t1.getTime() + 5_000));
    expect(await hook(statusBody(wamid, "delivered"))).toEqual({ statuses: 1, inbound: 0 });
    expect(await row()).toMatchObject({ status: "DELIVERED", waStatus: "delivered", deliveredAt: clock.now() });
    expect(await hook(statusBody(wamid, "delivered"))).toEqual({ statuses: 0, inbound: 0 }); // idempotent
    clock.set(new Date(t1.getTime() + 60_000));
    expect(await hook(statusBody(wamid, "read"))).toEqual({ statuses: 1, inbound: 0 });
    const read = await row();
    expect(read).toMatchObject({ status: "DELIVERED", waStatus: "read", waReadAt: clock.now() });
    // Late or out-of-order events never move it back.
    expect(await hook(statusBody(wamid, "sent"))).toEqual({ statuses: 0, inbound: 0 });
    expect(await hook(statusBody(wamid, "delivered"))).toEqual({ statuses: 0, inbound: 0 });
    expect(await hook(statusBody(wamid, "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] }))).toEqual({ statuses: 0, inbound: 0 });
    expect(await row()).toMatchObject({ status: "DELIVERED", waStatus: "read", waReadAt: read.waReadAt, deliveredAt: read.deliveredAt, waFailedAt: null });

    // A message Meta could not deliver: FAILED with the code, and the desk gets the same message to send by hand.
    const failedRow = () => prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m2.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_API" } });
    const w2 = (await failedRow()).providerId!;
    const failed = statusBody(w2, "failed", { errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Receiver is incapable of receiving this message" } }] });
    expect(await hook(failed)).toEqual({ statuses: 1, inbound: 0 });
    const f = await failedRow();
    expect(f).toMatchObject({ status: "FAILED", waStatus: "failed", waErrorCode: 131026 });
    expect(f.error).toMatch(/131026.*undeliverable/i);
    const manual = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m2.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_MANUAL" } });
    expect(manual.status).toBe("QUEUED");
    expect(manual.error).toMatch(/Automatic WhatsApp failed/);
    // The same failure again, or a late "delivered": nothing changes, no second task.
    expect(await hook(failed)).toEqual({ statuses: 0, inbound: 0 });
    expect(await hook(statusBody(w2, "delivered"))).toEqual({ statuses: 0, inbound: 0 });
    expect(await prisma.notificationDelivery.count({ where: { memberId: m2.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_MANUAL" } })).toBe(1);
    expect((await failedRow()).status).toBe("FAILED");
  });

  it("WA-43: an inbound STOP (any case) opts that phone out, stops what is still waiting and confirms in-app — once", async () => {
    setEnv(true);
    const m = await optedInMember("Stop Shalini");
    const from = `91${m.member.phone}`;
    await withTx((tx) => notifyMember(tx, { event: "DUES_REMINDER", userId: m.member.userId!, memberId: m.memberId, title: "₹400 due", body: "Please pay at the club.", dedupeKey: "wa-stop-test" }));
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa-stop-test", channel: "WHATSAPP_MANUAL" } })).status).toBe("QUEUED");
    const body = inboundBody("wamid.IN1", from, "  Stop ");
    expect(await hook(body)).toEqual({ statuses: 0, inbound: 1 });
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: m.member.userId }))).toBe(false);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } })).whatsappOptOutAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.member.userId! } })).notifyWhatsapp).toBe(false);
    expect(await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: "wa-stop-test", channel: "WHATSAPP_MANUAL" } })).toMatchObject({ status: "SKIPPED", error: "The person replied STOP on WhatsApp" });
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "WHATSAPP_OPT_OUT" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "whatsapp.opt_out", entityId: "wamid.IN1" } })).toBe(1);
    // Meta delivers the same webhook again: nothing more happens.
    expect(await hook(body)).toEqual({ statuses: 0, inbound: 0 });
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "WHATSAPP_OPT_OUT" } })).toBe(1);
    // STOP is not a reply task; "stop it please" is not a STOP.
    expect(await prisma.notificationDelivery.count({ where: { event: "WHATSAPP_REPLY" } })).toBe(0);
    // The member can opt in again in the portal (a later consent wins).
    clock.set(new Date(clock.now().getTime() + 60_000));
    await setMyWhatsappOptIn(m.actor, { optIn: true });
    expect(await withTx((tx) => whatsappOptedIn(tx, { userId: m.member.userId }))).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.member.userId! } })).notifyWhatsapp).toBe(true);
    // A guest's STOP works the same way.
    await createTrialBooking({ name: "Trial Toby", phone: "9811100020", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "15:00", consent: true, whatsappOptIn: true });
    const g = await prisma.guest.findUniqueOrThrow({ where: { phone: "9811100020" } });
    expect(await hook(inboundBody("wamid.IN2", "919811100020", "STOP"))).toEqual({ statuses: 0, inbound: 1 });
    expect(await withTx((tx) => whatsappOptedIn(tx, { guestId: g.id }))).toBe(false);
  });

  it("WA-44: any other inbound message is a 'replied on WhatsApp' task for the desk with a wa.me link (once per message)", async () => {
    setEnv(true);
    const m = await makeMember(w, { name: "Reply Ravi", plan: "SILVER" });
    const from = `91${m.member.phone}`;
    expect(await hook(inboundBody("wamid.R1", from, "Can I move my booking to 7pm?\nThanks"))).toEqual({ statuses: 0, inbound: 1 });
    const task = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "WHATSAPP_REPLY" } });
    expect(task).toMatchObject({ channel: "WHATSAPP_MANUAL", status: "QUEUED", userId: m.member.userId, memberId: m.memberId, toAddress: from, title: "Member replied on WhatsApp: Reply Ravi", body: "Can I move my booking to 7pm? Thanks" });
    expect(await hook(inboundBody("wamid.R1", from, "Can I move my booking to 7pm?\nThanks"))).toEqual({ statuses: 0, inbound: 0 }); // redelivered
    expect(await hook(inboundBody("wamid.R2", from, "stop it please"))).toEqual({ statuses: 0, inbound: 1 });
    expect(await prisma.notificationDelivery.count({ where: { event: "WHATSAPP_REPLY" } })).toBe(1); // added to the open task
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: task.id } })).body).toBe("Can I move my booking to 7pm? Thanks\nstop it please");
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } })).whatsappOptOutAt).toBeNull();
    const open = await openManualMessage(w.actors.FRONT_DESK, task.id);
    expect(open.url).toBe(`https://wa.me/${from}?text=${encodeURIComponent("Hi Reply, ")}`);
    // A number the club does not know: the task names the WhatsApp profile; the person is kept as a guest contact.
    expect(await hook(inboundBody("wamid.R3", "919811100030", "Do you have a cricket net free tonight?", "Neha Visitor"))).toEqual({ statuses: 0, inbound: 1 });
    const t2 = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "WHATSAPP_REPLY", toAddress: "919811100030" } });
    expect(t2.title).toBe("Someone replied on WhatsApp: Neha Visitor");
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: t2.guestId! } })).phone).toBe("9811100030");
    // Non-text messages still make a task.
    const img = envelope({ contacts: [{ wa_id: from, profile: { name: "Ravi" } }], messages: [{ id: "wamid.R4", from: "919811100030", timestamp: ts(), type: "image", image: { id: "x" } }] });
    expect(await hook(img)).toEqual({ statuses: 0, inbound: 1 });
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: t2.id } })).body).toContain("[image]");
  });
});

describe("WA-20…WA-24 — the signed /r/<token> page (§5.3)", () => {
  async function cancelled(name: string, time = "18:00", court = "Court 1") {
    const m = await makeMember(w, { name, plan: "SILVER" });
    const b = await book(w, { court, time, players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    return { m, b };
  }

  it("WA-20/WA-21: shows the cancelled session (first name only) and reschedules once, every booking rule applying, no extra charge", async () => {
    await enableWhatsApp();
    const { m, b } = await cancelled("Rain Riya");
    await setMyWhatsappOptIn(m.actor, { optIn: true });
    await closeCourts(w.actors.MANAGER, wet());
    await settleAfterCommit();
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    // The token is the one the WhatsApp button carries.
    const token = (sends()[0].body!.template as { components: Array<{ parameters: Array<{ text: string }> }> }).components[1].parameters[0].text;
    const v = await viewResolution(token);
    expect(v).toMatchObject({ state: "OPEN", session: { firstName: "Rain", court: "Court 1", sport: "TENNIS", bookingCode: b.bookingCode, reason: "Wet court: Rain overnight", amountPaid: 15000 }, today: "2026-10-12", rescheduleUntil: "2026-10-26" });
    expect(JSON.stringify(v)).not.toContain(m.member.phone);
    expect(JSON.stringify(v)).not.toContain("Riya");

    // Booking rules apply: a taken slot is refused and the link stays usable.
    const other = await makeMember(w, { name: "Other Om", plan: "SILVER" });
    await book(w, { court: "Court 2", date: "2026-10-14", time: "18:00", players: [{ memberId: other.memberId }] });
    await expect(resolveByLink(token, { choice: "RESCHEDULE", courtId: w.courts["Court 2"].id, date: "2026-10-14", startTime: "18:00" })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    await expect(resolveByLink(token, { choice: "RESCHEDULE", courtId: w.courts["Court 2"].id, date: "2026-10-30", startTime: "18:00" })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
    expect((await viewResolution(token)).state).toBe("OPEN");

    calls = [];
    const payments = await prisma.payment.count();
    const done = await resolveByLink(token, { choice: "RESCHEDULE", courtId: w.courts["Court 2"].id, date: "2026-10-20", startTime: "19:00" });
    expect(done).toMatchObject({ state: "DONE", outcome: { kind: "RESCHEDULED", court: "Court 2" } });
    const after = await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } });
    expect([after.status, after.resolvedVia, after.resolvedBy]).toEqual(["RESCHEDULED", "MEMBER", m.member.userId]);
    const nb = await prisma.booking.findUniqueOrThrow({ where: { id: after.newBookingId! } });
    expect(nb.primaryMemberId).toBe(m.memberId);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: nb.billId! } });
    expect([bill.total, bill.status]).toEqual([0, "PAID"]);
    expect(await prisma.payment.count()).toBe(payments);
    expect(await prisma.auditLog.count({ where: { action: "club_cancellation.link_used", entityId: cc.id } })).toBe(1);
    // Reschedule confirmed → booking_rescheduled on WhatsApp (sent after commit), button = the new booking code.
    await settleAfterCommit();
    const moved = sends().map((c) => c.body!.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> });
    expect(moved).toHaveLength(1);
    expect(moved[0].name).toBe("cc_booking_rescheduled");
    expect(moved[0].components[0].parameters.map((p) => p.text)).toEqual(["Rain", "Court 2", "7:00 pm", "Tue, 20 Oct 2026", nb.bookingCode]);
    expect(moved[0].components[1].parameters[0].text).toBe(nb.bookingCode);

    // WA-23: single use — the page now shows only the outcome, and a second choice is refused.
    await expect(resolveByLink(token, { choice: "REFUND" })).rejects.toMatchObject({ code: "LINK_USED" });
    expect(await viewResolution(token)).toMatchObject({ state: "DONE", outcome: { kind: "RESCHEDULED", bookingCode: nb.bookingCode } });
  });

  it("WA-22: Refund creates the approved refund (cash: collected at the desk); a guest's booking works too", async () => {
    const { b } = await cancelled("Refund Rekha");
    const g = await book(w, { time: "19:00", players: [{ guest: { name: "Guest Gopal", phone: "9811100040" } }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, wet());
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    const token = signResolutionToken(cc.id, cc.deadlineAt);
    const r = await resolveByLink(token, { choice: "REFUND" });
    expect(r).toMatchObject({ state: "DONE", outcome: { kind: "REFUNDED", amount: 15000, collectAtDesk: true } });
    const after = await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } });
    const req = await prisma.refundRequest.findUniqueOrThrow({ where: { id: after.refundRequestId! } });
    expect([after.status, after.resolvedVia, req.policy, req.amount, req.autoApproved]).toEqual(["REFUNDED", "MEMBER", "CC-5", 15000, true]);
    expect(await prisma.auditLog.count({ where: { action: "club_cancellation.link_used", entityId: cc.id } })).toBe(1);
    expect(["APPROVED", "COMPLETED"]).toContain(req.status);
    expect(r.state === "DONE" && r.outcome.kind === "REFUNDED" && r.outcome.refundCode).toBe(req.code);
    await expect(resolveByLink(token, { choice: "RESCHEDULE", courtId: w.courts["Court 2"].id, date: "2026-10-20", startTime: "19:00" })).rejects.toMatchObject({ code: "LINK_USED" });

    const gcc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: g.bookingId } });
    const gv = await viewResolution(signResolutionToken(gcc.id, gcc.deadlineAt));
    expect(gv).toMatchObject({ state: "OPEN", session: { firstName: "Guest" } });
    expect(await resolveByLink(signResolutionToken(gcc.id, gcc.deadlineAt), { choice: "REFUND" })).toMatchObject({ state: "DONE", outcome: { kind: "REFUNDED", amount: 40000 } });
  });

  it("WA-23: expired, used, forged or foreign tokens are rejected", async () => {
    const { b } = await cancelled("Late Lalit");
    await closeCourts(w.actors.MANAGER, wet());
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    const token = signResolutionToken(cc.id, cc.deadlineAt);
    // Forged: a changed signature, a changed id or expiry, garbage, or a token made with another secret.
    const parts = token.split(".");
    const forged = [
      `${parts.slice(0, 3).join(".")}.${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`,
      [parts[0], `${parts[1]}x`, parts[2], parts[3]].join("."),
      [parts[0], parts[1], (parseInt(parts[2], 36) + 86_400).toString(36), parts[3]].join("."),
      "R1.abc", "", "not-a-token",
    ];
    for (const f of forged) {
      expect(verifyResolutionToken(f)).toBeNull();
      expect(await viewResolution(f)).toEqual({ state: "INVALID" });
      await expect(resolveByLink(f, { choice: "REFUND" })).rejects.toMatchObject({ code: "LINK_INVALID" });
    }
    const secret = process.env.APP_SECRET;
    process.env.APP_SECRET = "someone-elses-secret";
    const foreign = signResolutionToken(cc.id, cc.deadlineAt);
    process.env.APP_SECRET = secret;
    expect(verifyResolutionToken(foreign)).toBeNull();
    await expect(resolveByLink(foreign, { choice: "REFUND" })).rejects.toMatchObject({ code: "LINK_INVALID" });
    // Properly signed but for no club cancellation.
    await expect(resolveByLink(signResolutionToken("cknotacancellation", cc.deadlineAt), { choice: "REFUND" })).rejects.toMatchObject({ code: "LINK_INVALID" });

    // Expired at the resolution deadline.
    expect(verifyResolutionToken(token)).toEqual({ clubCancellationId: cc.id });
    clock.set(new Date(cc.deadlineAt.getTime() + 1000));
    expect(verifyResolutionToken(token)).toBeNull();
    expect(await viewResolution(token)).toMatchObject({ state: "EXPIRED", session: { bookingCode: b.bookingCode } });
    await expect(resolveByLink(token, { choice: "REFUND" })).rejects.toMatchObject({ code: "LINK_EXPIRED" });
    expect((await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } })).status).toBe("PENDING_CHOICE");
  });

  it("WA-24: choices are rate limited per link and per device", async () => {
    const { b } = await cancelled("Busy Bhavna");
    await closeCourts(w.actors.MANAGER, wet());
    const cc = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    const token = signResolutionToken(cc.id, cc.deadlineAt);
    const taken = { choice: "RESCHEDULE" as const, courtId: w.courts["Court 1"].id, date: "2026-10-12", startTime: "18:00" }; // closed court
    for (let i = 0; i < 10; i++) await expect(resolveByLink(token, taken, { ip: "10.0.0.1" })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    await expect(resolveByLink(token, { choice: "REFUND" }, { ip: "10.0.0.2" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await prisma.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } })).status).toBe("PENDING_CHOICE");
    resetRateLimits();
    for (let i = 0; i < 20; i++) await expect(resolveByLink(`R1.x${i}.zz.sig`, { choice: "REFUND" }, { ip: "10.0.0.3" })).rejects.toMatchObject({ code: "LINK_INVALID" });
    await expect(resolveByLink(token, { choice: "REFUND" }, { ip: "10.0.0.3" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await resolveByLink(token, { choice: "REFUND" }, { ip: "10.0.0.4" })).toMatchObject({ state: "DONE" });
  });
});
