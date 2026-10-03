// Completion pass phase 2: first run (setup wizard gate) and communication (email only when verified, WhatsApp
// links logged as OPENED, the Owner's message log).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { setMailTransportForTests } from "@/server/services/notifications";
import { flushDeliveries } from "@/server/services/channels";
import { listMessages, sendTestEmail, waNumber, whatsappLink } from "@/server/services/messages";
import { completeSetup, isSetupComplete, setupStatus } from "@/server/services/setup";
import { getSettings, updateSetting } from "@/server/services/settings";
import { createLead, createQuote } from "@/server/services/crm";
import { createMember } from "@/server/services/membership";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { makeWorld, type World } from "../helpers/world";
import { book, guest } from "../helpers/booking";
import { utr } from "../helpers/world";

let w: World;
const sent: Array<{ to: string; subject: string }> = [];

beforeEach(async () => {
  w = await makeWorld();
  sent.length = 0;
});
afterEach(() => setMailTransportForTests(null));

describe("Completion §3 — email only when it really works", () => {
  // v3 WK-2/§6.3 (D-70): the welcome now goes out when the first membership is paid, through the channel log.
  const paidPlan = { code: "SILVER" as const, months: 1 as const, payment: { method: "UPI" as const, reference: utr() } };
  it("email off: nothing is queued (no promise); on: queued, delivered and logged", async () => {
    setCapabilityOverridesForTests({ email: false });
    await createMember(w.actors.FRONT_DESK, { name: "No Mail Nia", phone: "9811122233", dob: "1990-01-01", email: "nia@example.com", plan: paidPlan });
    expect(await prisma.notificationDelivery.count({ where: { channel: "EMAIL", status: { not: "SKIPPED" } } })).toBe(0);
    setCapabilityOverridesForTests({ email: true });
    await createMember(w.actors.FRONT_DESK, { name: "Mail Mo", phone: "9811122234", dob: "1990-01-01", email: "mo@example.com", plan: { ...paidPlan, payment: { method: "UPI", reference: utr() } } });
    expect(await prisma.notificationDelivery.count({ where: { channel: "EMAIL", status: "QUEUED", toAddress: "mo@example.com" } })).toBe(1);
    setMailTransportForTests({ sendMail: async (m) => void sent.push(m) });
    expect(await flushDeliveries()).toMatchObject({ sent: 1, failed: 0 });
    expect(sent[0].subject).toMatch(/^Welcome to The Champions Club/);
    const log = await listMessages(w.actors.OWNER, { channel: "EMAIL" });
    expect(log[0]).toMatchObject({ to: "mo@example.com", status: "SENT" });
  });

  it("a failed delivery is logged as FAILED with the SMTP error", async () => {
    await createMember(w.actors.FRONT_DESK, { name: "Bounce Bo", phone: "9811122235", dob: "1990-01-01", email: "bo@example.com", plan: { ...paidPlan, payment: { method: "UPI", reference: utr() } } });
    setMailTransportForTests({ sendMail: async () => { throw new Error("550 mailbox unavailable"); } });
    expect(await flushDeliveries()).toMatchObject({ sent: 0, failed: 1 });
    expect((await listMessages(w.actors.OWNER, { status: "FAILED" }))[0]).toMatchObject({ to: "bo@example.com", error: "550 mailbox unavailable" });
  });

  it("the Owner's test email verifies email; a failing SMTP doesn't", async () => {
    setMailTransportForTests({ sendMail: async () => { throw new Error("connect ECONNREFUSED"); } });
    await expect(sendTestEmail(w.actors.OWNER, { to: "owner@example.com" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await getSettings()).email_verified_at).toBeNull();
    setMailTransportForTests({ sendMail: async (m) => void sent.push(m) });
    const r = await sendTestEmail(w.actors.OWNER, { to: "owner@example.com" });
    expect((await getSettings()).email_verified_at).toBe(r.verifiedAt);
    expect(sent).toHaveLength(1);
    await expect(sendTestEmail(w.actors.MANAGER, { to: "x@example.com" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a quote can't be 'emailed' while email is off", async () => {
    setCapabilityOverridesForTests({ email: false });
    const l = await createLead(w.actors.FRONT_DESK, { name: "Quote Quinn", phone: "9876500011", email: "quinn@example.com", source: "WALK_IN" });
    await expect(createQuote(w.actors.FRONT_DESK, l.id, { lines: [{ planCode: "SILVER", months: 3 }], send: "EMAIL" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect((await createQuote(w.actors.FRONT_DESK, l.id, { lines: [{ planCode: "SILVER", months: 3 }], send: "LINK" })).total).toBeGreaterThan(0);
  });
});

describe("Completion §3 — WhatsApp links", () => {
  it("builds the text from the record, returns a wa.me link and logs it as OPENED", async () => {
    const g = await prisma.guest.create({ data: { name: "Wa Wendy", phone: "9898989898" } });
    const b = await book(w, { time: "18:00", players: [{ guestId: g.id }] });
    const r = await whatsappLink(w.actors.FRONT_DESK, { template: "BOOKING", bookingId: b.bookingId });
    expect(r.url.startsWith("https://wa.me/919898989898?text=")).toBe(true);
    expect(r.text).toContain(b.bookingCode);
    expect(r.text).toMatch(/₹400(\.00)? is due at the front desk/);
    const log = await listMessages(w.actors.OWNER, { channel: "WHATSAPP" });
    expect(log[0]).toMatchObject({ status: "OPENED", entity: "booking", entityId: b.bookingId, to: "919898989898", actorName: "Farah Desk" });
  });

  it("rejects bookings without a valid mobile; members can't send; only the Owner reads the log", async () => {
    const b = await book(w, { time: "19:00", players: [guest("No Phone Ned")] });
    await expect(whatsappLink(w.actors.FRONT_DESK, { template: "BOOKING", bookingId: b.bookingId })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const member: UserActor = { kind: "USER", userId: w.actors.FRONT_DESK.userId, role: "MEMBER", name: "M", memberId: "x", employeeId: null };
    await expect(whatsappLink(member, { template: "CUSTOM", phone: "9898989898", text: "hi" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listMessages(w.actors.MANAGER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect([waNumber("+91 98989 89898"), waNumber("09898989898"), waNumber("12345")]).toEqual(["919898989898", "919898989898", null]);
  });
});

describe("Completion §4 — first-run setup", () => {
  it("is incomplete on a fresh install; completes only when every required step is done", async () => {
    expect(await isSetupComplete()).toBe(false);
    const club = (await getSettings()).club;
    await updateSetting(SYSTEM, "club", { ...club, address: "" });
    let st = await setupStatus(w.actors.OWNER);
    expect(st.ready).toBe(false);
    expect(st.steps.find((s) => s.key === "identity")?.done).toBe(false);
    await expect(completeSetup(w.actors.OWNER)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateSetting(SYSTEM, "club", { ...club, address: "1 Club Road, Ahmedabad" });
    st = await setupStatus(w.actors.OWNER);
    expect(st.ready).toBe(true);
    await completeSetup(w.actors.OWNER);
    expect(await isSetupComplete()).toBe(true);
    await expect(setupStatus(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a GSTIN that fails the check digit blocks setup until fixed or removed", async () => {
    const club = (await getSettings()).club;
    await updateSetting(SYSTEM, "club", { ...club, address: "1 Club Road", gstin: "24AAACC1206D1ZA" });
    expect((await setupStatus(w.actors.OWNER)).steps.find((s) => s.key === "gst")?.done).toBe(false);
    await updateSetting(SYSTEM, "club", { ...club, address: "1 Club Road", gstin: "" });
    expect((await setupStatus(w.actors.OWNER)).ready).toBe(true);
  });
});
