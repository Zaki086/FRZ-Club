// v3 phase 5: notification channels (§6.3, NT-4), walk-in credentials (§6.4, WK-1…WK-7), expiry and dues (§6.5).
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { addDays, istToUtc } from "@/lib/time";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { login, redeemPasswordSetToken, tokenHash } from "@/server/auth/sessions";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import {
  flushDeliveries, markManualSent, notifyMember, openManualMessage, setChannelTransportsForTests, setMyPreferences, subscribePush,
} from "@/server/services/channels";
import { runDuesReminders } from "@/server/services/dues";
import { listView } from "@/server/services/filters";
import { createMember, credentialsStatus, reissueCredentials, renewMembership, runMembershipJob } from "@/server/services/membership";
import { setMailTransportForTests } from "@/server/services/notifications";
import { recordCounterPayment } from "@/server/services/payments";
import { updateSetting } from "@/server/services/settings";
import { setMyWhatsappOptIn } from "@/server/services/whatsapp/opt-in";
import { handleWebhook } from "@/server/services/whatsapp/webhook";
import { makeWorld, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";

let w: World;
const sent: Array<{ to: string; subject: string; text: string }> = [];
beforeEach(async () => {
  w = await makeWorld();
  sent.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void sent.push(m as never) });
});
afterEach(() => {
  setMailTransportForTests(null);
  setChannelTransportsForTests({ push: null, fetch: null });
  setCapabilityOverridesForTests({ email: true });
});

const rows = (dedupeKey: string) => prisma.notificationDelivery.findMany({ where: { dedupeKey }, orderBy: { channel: "asc" } });
const byChannel = async (dedupeKey: string) => Object.fromEntries((await rows(dedupeKey)).map((d) => [d.channel, d.status]));

async function message(userId: string, key = "test:1") {
  return withTx((tx) => notifyMember(tx, { event: "DUES_REMINDER", userId, title: "₹400 due", body: "Please pay at the club.", link: "/portal", dedupeKey: key }));
}

describe("v3 §6.3 — channels (NT-4)", () => {
  it("fans out to every channel exactly once; unavailable channels are SKIPPED with the reason, never SENT", async () => {
    const m = await makeMember(w, { name: "Channel Chandni", plan: "SILVER", email: "chandni@example.com" });
    const first = await message(m.member.userId!);
    expect(first.map((x) => x.channel)).toEqual(["IN_APP", "PUSH", "EMAIL", "WHATSAPP_API", "WHATSAPP_MANUAL"]);
    expect(await message(m.member.userId!)).toEqual([]); // same key: nothing new
    // v6 SA-4 (default ONLY_IF_NO_OTHER_CHANNEL): the email reaches her, so no manual WhatsApp task.
    expect(await byChannel("test:1")).toEqual({ IN_APP: "SENT", PUSH: "SKIPPED", EMAIL: "QUEUED", WHATSAPP_API: "SKIPPED", WHATSAPP_MANUAL: "SKIPPED" });
    const push = (await rows("test:1")).find((d) => d.channel === "PUSH")!;
    expect(push.error).toMatch(/Push not available/);
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "DUES_REMINDER" } })).toBe(1);
    // The worker sends email; manual WhatsApp is never sent by the system.
    // (The membership confirmation from sign-up is queued too: two emails.)
    expect(await flushDeliveries()).toEqual({ sent: 2, failed: 0 });
    expect(await byChannel("test:1")).toMatchObject({ EMAIL: "SENT", WHATSAPP_MANUAL: "SKIPPED" });
    expect(sent.map((s) => [s.to, s.subject])).toContainEqual(["chandni@example.com", "₹400 due"]);
    // Email switched off: the next message records it as not available.
    setCapabilityOverridesForTests({ email: false });
    await message(m.member.userId!, "test:2");
    expect((await byChannel("test:2")).EMAIL).toBe("SKIPPED");
    // v6 SA-4: nothing else reaches her now → the manual WhatsApp task for the desk.
    expect((await byChannel("test:2")).WHATSAPP_MANUAL).toBe("QUEUED");
  });

  it("member preferences are respected (in-app always stays on)", async () => {
    const m = await makeMember(w, { name: "Pref Priya", plan: "SILVER", email: "priya@example.com" });
    await setMyPreferences(m.actor, { email: false, whatsapp: false });
    await message(m.member.userId!);
    const d = await rows("test:1");
    expect(Object.fromEntries(d.map((x) => [x.channel, [x.status, x.error]]))).toMatchObject({
      IN_APP: ["SENT", null], EMAIL: ["SKIPPED", "Turned off by the member"], WHATSAPP_MANUAL: ["SKIPPED", "Turned off by the member"],
    });
  });

  it("Web Push: only with a device opted in; a 410 removes the dead subscription", async () => {
    const m = await makeMember(w, { name: "Push Pooja", plan: "SILVER" });
    setCapabilityOverridesForTests({ email: true, push: true });
    await message(m.member.userId!, "p:0");
    expect((await byChannel("p:0")).PUSH).toBe("SKIPPED"); // no device yet
    await subscribePush(m.actor, { endpoint: "https://push.example.net/sub/1", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
    const payloads: string[] = [];
    setChannelTransportsForTests({ push: async (_s, p) => void payloads.push(p) });
    await message(m.member.userId!, "p:1");
    await flushDeliveries();
    expect((await byChannel("p:1")).PUSH).toBe("SENT");
    expect(JSON.parse(payloads[0])).toMatchObject({ title: "₹400 due", url: `${process.env.APP_URL}/portal` }); // v6 URL-1: push url is absolute on APP_URL
    setChannelTransportsForTests({ push: async () => Promise.reject(Object.assign(new Error("Gone"), { statusCode: 410 })) });
    await message(m.member.userId!, "p:2");
    await flushDeliveries();
    expect((await byChannel("p:2")).PUSH).toBe("FAILED");
    expect(await prisma.pushSubscription.count({ where: { userId: m.member.userId! } })).toBe(0);
  });

  it("WhatsApp API: template messages only; delivery comes from the signed webhook; manual fallback is skipped", async () => {
    // v4 §5 (WHATSAPP): the §5.1 env names, a mapped APPROVED template (Settings → WhatsApp), the member's opt-in and
    // the event's typed `wa` values; the message is sent right after commit; the webhook is whatsapp/webhook.ts.
    const env = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "1098765", WHATSAPP_GRAPH_API_VERSION: "v23.0", WHATSAPP_APP_SECRET: "test-app-secret" };
    Object.assign(process.env, env);
    try {
      const m = await makeMember(w, { name: "Whats Wasim", plan: "SILVER" });
      await setMyWhatsappOptIn(m.actor, { optIn: true });
      await updateSetting(w.actors.OWNER, "whatsapp_template_map", { dues_reminder: { name: "dues_reminder", language: "en", status: "APPROVED", checked_at: null } });
      setCapabilityOverridesForTests({ email: true, "whatsapp.api": true });
      const calls: Array<Record<string, unknown>> = [];
      setChannelTransportsForTests({ fetch: (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST1" }] }), { status: 200 }); }) as typeof fetch });
      await withTx((tx) => notifyMember(tx, { event: "DUES_REMINDER", userId: m.member.userId!, title: "₹400 due", body: "Please pay.", dedupeKey: "wa:1", params: ["Wasim", "₹400", "court booking", "4"], wa: { template: "dues_reminder", vars: { name: "Wasim", amount: "400", whatFor: "court booking" } } }));
      await settleAfterCommit();
      expect(await byChannel("wa:1")).toMatchObject({ WHATSAPP_API: "SENT", WHATSAPP_MANUAL: "SKIPPED" });
      expect(calls[0]).toMatchObject({ type: "template", to: `91${m.member.phone}`, template: { name: "dues_reminder", language: { code: "en" } } });
      const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.TEST1", status: "delivered" }] } }] }] });
      await expect(handleWebhook(body, "sha256=00")).rejects.toMatchObject({ code: "FORBIDDEN" });
      const sig = "sha256=" + createHmac("sha256", "test-app-secret").update(body).digest("hex");
      expect(await handleWebhook(body, sig)).toEqual({ statuses: 1, inbound: 0 });
      expect((await byChannel("wa:1")).WHATSAPP_API).toBe("DELIVERED");
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("manual WhatsApp: one click opens wa.me (LINK_OPENED), staff mark it sent; the log shows it", async () => {
    const m = await makeMember(w, { name: "Manual Manu", plan: "SILVER" });
    await message(m.member.userId!);
    const d = (await rows("test:1")).find((x) => x.channel === "WHATSAPP_MANUAL")!;
    await expect(openManualMessage(w.actors.KITCHEN, d.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const open = await openManualMessage(w.actors.FRONT_DESK, d.id);
    expect(open.url).toMatch(new RegExp(`^https://wa\\.me/91${m.member.phone}\\?text=`));
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("LINK_OPENED");
    await markManualSent(w.actors.FRONT_DESK, d.id);
    await expect(markManualSent(w.actors.FRONT_DESK, d.id)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    const log = await listView(w.actors.FRONT_DESK, "notifications", { channel: "WHATSAPP_MANUAL", type: "DUES_REMINDER" });
    expect(log.rows.map((r) => [r.status, r.handled_by_name])).toEqual([["SENT", "Farah Desk"]]);
    await expect(listView(w.actors.BAR_STAFF, "notifications", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v3 §6.4 — walk-in credentials", () => {
  async function walkIn(opts: { pay?: boolean; email?: string; dob?: string; guardian?: boolean } = {}) {
    return createMember(w.actors.FRONT_DESK, {
      name: "Walkin Vikas", phone: "9876512345", email: opts.email, dob: opts.dob ?? "1992-02-02",
      ...(opts.guardian ? { guardianName: "Parent Vikas", guardianPhone: "9876500000" } : {}),
      // WK-1: a password sent by an old client is ignored.
      ...({ password: "should-be-ignored" } as object),
      plan: { code: "SILVER", months: 1, payment: opts.pay === false ? undefined : { method: "UPI", reference: utr() } },
    });
  }

  it("WK-1/WK-2/WK-3: no password at sign-up; the first paid membership issues a one-time 72-hour link (stored hashed only)", async () => {
    const r = await walkIn({ pay: false });
    const member = await prisma.member.findUniqueOrThrow({ where: { id: r.memberId } });
    let user = await prisma.user.findUniqueOrThrow({ where: { id: member.userId! } });
    expect([user.passwordHash, user.credentialsIssuedAt, r.setPasswordToken]).toEqual([null, null, null]);
    expect(await prisma.passwordSetToken.count({ where: { userId: user.id } })).toBe(0);
    await expect(login("9876512345", "should-be-ignored")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Paid later at the desk → login link issued in the same transaction.
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: r.billId!, method: "UPI", amount: 200000, reference: utr() });
    user = await prisma.user.findUniqueOrThrow({ where: { id: member.userId! } });
    expect(user.credentialsIssuedAt).not.toBeNull();
    const tok = await prisma.passwordSetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(Math.round((tok.expiresAt.getTime() - clock.now().getTime()) / 3_600_000)).toBe(72);
    const welcome = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: r.memberId, event: "MEMBERSHIP_WELCOME", channel: "WHATSAPP_MANUAL" } });
    const token = /\/set-password\/([A-Za-z0-9_-]+)/.exec(welcome.whatsappText!)![1];
    expect(tok.tokenHash).toBe(tokenHash(token)); // only the hash is stored
    expect(welcome.whatsappText).toMatch(new RegExp(`${member.memberCode}[\\s\\S]*9876512345`));
    await redeemPasswordSetToken(token, "my-own-password");
    expect((await login("9876512345", "my-own-password")).user.role).toBe("MEMBER");
    expect((await login(member.memberCode.toLowerCase(), "my-own-password")).user.id).toBe(user.id); // member code works too
  });

  it("WK-4/WK-5: paid at sign-up → the desk gets the link for the QR and the welcome goes out on every available channel", async () => {
    const r = await walkIn({ email: "vikas@example.com" });
    expect(r.setPasswordToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const st = await credentialsStatus(w.actors.FRONT_DESK, r.memberId);
    expect(st).toMatchObject({ username: "9876512345", canLogIn: false, noOwnLogin: false });
    expect(st.linkActiveUntil).not.toBeNull();
    // v6 SA-4: the welcome email reaches him, so no manual WhatsApp task.
    expect(Object.fromEntries(st.deliveries.map((d) => [d.channel, d.status]))).toEqual({ IN_APP: "SENT", PUSH: "SKIPPED", EMAIL: "QUEUED", WHATSAPP_API: "SKIPPED", WHATSAPP_MANUAL: "SKIPPED" });
  });

  it("guardian-managed Juniors under 13 get no login", async () => {
    clock.set(T("2026-10-12"));
    const r = await createMember(w.actors.FRONT_DESK, {
      name: "Little Lila", phone: "9876512399", dob: "2016-06-06", guardianName: "Parent Lila", guardianPhone: "9876500099",
      plan: { code: "JUNIOR", months: 1, payment: { method: "UPI", reference: utr() } },
    });
    expect(r.setPasswordToken).toBeNull();
    expect((await credentialsStatus(w.actors.FRONT_DESK, r.memberId)).noOwnLogin).toBe(true);
    await expect(reissueCredentials(w.actors.FRONT_DESK, r.memberId)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("WK-6: the desk reissues a link and the old one stops working; WK-7: a renewal sends a confirmation, not new credentials", async () => {
    const r = await walkIn();
    const again = await reissueCredentials(w.actors.FRONT_DESK, r.memberId);
    await expect(redeemPasswordSetToken(r.setPasswordToken!, "first-link-pass")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(reissueCredentials(w.actors.BAR_STAFF, r.memberId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await redeemPasswordSetToken(again.token, "second-link-pass");
    const before = await prisma.passwordSetToken.count();
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: ren.billId, method: "UPI", amount: ren.total, reference: utr() });
    expect(await prisma.passwordSetToken.count()).toBe(before);
    expect(await prisma.notificationDelivery.count({ where: { memberId: r.memberId, event: "MEMBERSHIP_RENEWED", channel: "IN_APP" } })).toBe(1);
  });
});

const T = (d: string) => istToUtc(d, "10:00");

describe("v3 §6.5 — expiry and dues", () => {
  it("NT-1: expiry reminders go out on every channel exactly once per membership, type and channel", async () => {
    const m = await makeMember(w, { name: "Expiry Esha", plan: "SILVER", email: "esha@example.com" });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: m.membershipId! } });
    clock.set(T(addDays(ms.endDate.toISOString().slice(0, 10), -7)));
    await runMembershipJob();
    await runMembershipJob();
    const d = await prisma.notificationDelivery.findMany({ where: { memberId: m.memberId, event: "MEMBERSHIP_EXPIRY" } });
    expect(d.map((x) => x.channel).sort()).toEqual(["EMAIL", "IN_APP", "PUSH", "WHATSAPP_API", "WHATSAPP_MANUAL"]);
    const r = await listView(w.actors.FRONT_DESK, "renewals", {});
    const row = r.rows.find((x) => x.id === m.memberId)!;
    // v6 SA-4: email reaches her, so there is no WhatsApp task to send by hand.
    expect([row.status, row.last_event, row.manual_id !== null]).toEqual(["EXPIRING", "MEMBERSHIP_EXPIRY", false]);
    expect(String(row.how)).toContain("WHATSAPP_MANUAL:SKIPPED");
  });

  it("NT-2: dues reminder after 3 days unpaid, then weekly, at most 3; none once paid", async () => {
    const a = await makeMember(w, { name: "Dues Dev", plan: "SILVER", pay: false });
    const b = await makeMember(w, { name: "Dues Diya", plan: "SILVER", pay: false });
    clock.set(T("2026-10-14"));
    expect((await runDuesReminders()).sent).toBe(0); // 2 days
    clock.set(T("2026-10-15"));
    expect((await runDuesReminders()).sent).toBe(2);
    expect((await runDuesReminders()).sent).toBe(0);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: b.billId!, method: "UPI", amount: 200000, reference: utr() });
    for (const [day, n] of [["2026-10-20", 0], ["2026-10-22", 1], ["2026-10-29", 1], ["2026-11-05", 0], ["2026-11-30", 0]] as const) {
      clock.set(T(day));
      expect([day, (await runDuesReminders()).sent]).toEqual([day, n]);
    }
    expect(await prisma.duesReminder.count({ where: { billId: a.billId! } })).toBe(3);
    expect(await prisma.duesReminder.count({ where: { billId: b.billId! } })).toBe(1);
    const inApp = await prisma.notification.findMany({ where: { userId: a.member.userId!, type: "DUES_REMINDER" }, orderBy: { createdAt: "asc" } });
    expect(inApp.map((n) => n.title)).toEqual(["₹2,000 due for your membership", "₹2,000 due for your membership", "₹2,000 due for your membership"]);
    expect(inApp[2].body).toMatch(/last reminder/);
  });
});
