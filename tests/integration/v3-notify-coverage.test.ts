// Owner's question: "if we cancel or postpone (maintenance), dues, subscription expiry, refunds — is the member told by
// mail, push and phone?" One test per event family: the channel log rows (channel + event) for a member who has an
// email, a mobile number and a device with push turned on; preferences turning a channel off; guests; the worker.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { addDays, istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { cancelBooking, createMaintenance } from "@/server/services/booking";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { DELIVERY_MAX_ATTEMPTS, flushDeliveries, setChannelTransportsForTests, setMyPreferences, subscribePush } from "@/server/services/channels";
import { closeCourts, rescheduleClubCancellation } from "@/server/services/closures";
import { runDuesReminders, runInvoiceDueReminders, INVOICE_DUE_SOON_DAYS } from "@/server/services/dues";
import { testGateway } from "@/server/services/gateway";
import { createDraft, issueInvoice, markOverdueInvoices } from "@/server/services/invoices";
import { renewMembership, runMembershipJob } from "@/server/services/membership";
import { setMailTransportForTests } from "@/server/services/notifications";
import { recordCounterPayment, startOnlinePayment, verifyOnlinePayment } from "@/server/services/payments";
import { approveRefund, payOutRefund, rejectRefund, requestRefund } from "@/server/services/refunds";
import { cancelSocialSession, createSocialSession, joinSession } from "@/server/services/social";
import { runDailyJobs } from "@/server/jobs";
import { makeWorld, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
const mails: Array<{ to: string; subject: string; text: string }> = [];
const pushes: string[] = [];

beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026 10:00 IST
  setCapabilityOverridesForTests({ email: true, push: true });
  mails.length = 0;
  pushes.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void mails.push(m as never) });
  setChannelTransportsForTests({ push: async (_s, p) => void pushes.push(p) });
});
afterEach(() => {
  setMailTransportForTests(null);
  setChannelTransportsForTests({ push: null, fetch: null });
  setCapabilityOverridesForTests({ email: true });
});

/** Every channel, as the club is set up here: email + push real, no WhatsApp API → the desk's manual queue. */
const ALL = ["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:QUEUED", "WHATSAPP_API:SKIPPED", "WHATSAPP_MANUAL:QUEUED"];

let n = 0;
/** A member with an email address, a mobile number (from makeMember) and one device with push turned on. */
async function reachable(name: string, opts: { plan?: "SILVER" | "GOLD"; pay?: boolean; months?: 1 | 3 | 12 } = {}) {
  n++;
  const m = await makeMember(w, { name, plan: opts.plan ?? "SILVER", pay: opts.pay, months: opts.months, email: `member${n}@example.com` });
  await subscribePush(m.actor, { endpoint: `https://push.example.net/sub/${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
  return m;
}

/** "CHANNEL:STATUS" rows for one member and event (optionally one dedupe key prefix), sorted. */
async function rows(memberId: string, event: string, keyPrefix?: string) {
  const d = await prisma.notificationDelivery.findMany({ where: { memberId, event, ...(keyPrefix ? { dedupeKey: { startsWith: keyPrefix } } : {}) } });
  return d.map((x) => `${x.channel}:${x.status}`).sort();
}

describe("cancelled or moved by the club", () => {
  it("maintenance over a booking: refused unless confirmed, then CANCELLED_BY_CLUB on every channel with the choice; guests by email and phone", async () => {
    const m = await reachable("Maint Mira");
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, { guest: { name: "Guest Gopal", phone: "9876540011", email: "gopal@example.com" } }], payment: { kind: "COUNTER", method: "CASH" } });
    const input = { courtId: w.courts["Court 1"].id, date: "2026-10-12", startTime: "17:00", endTime: "20:00", note: "net repair" };
    // Never silently dropped or moved: the block is refused and names the booking.
    await expect(createMaintenance(w.actors.MANAGER, input)).rejects.toMatchObject({ code: "SLOT_TAKEN", message: expect.stringContaining(b.bookingCode), details: { needsClubCancellation: true } });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).status).toBe("CONFIRMED");
    // Confirmed: the club-cancellation path (reason Maintenance).
    const r = await createMaintenance(w.actors.MANAGER, { ...input, cancelBookings: true });
    expect(r.closure).toMatchObject({ cancelledBookings: 1, pendingChoice: 1 });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    expect([booking.status, booking.cancelReason]).toEqual(["CANCELLED_BY_CLUB", "Closed by the club — Maintenance: net repair"]);
    expect(await rows(m.memberId, "BOOKING_CANCELLED_BY_CLUB")).toEqual(ALL);
    const g = await prisma.guest.findFirstOrThrow({ where: { phone: "9876540011" } });
    const gd = await prisma.notificationDelivery.findMany({ where: { guestId: g.id, event: "BOOKING_CANCELLED_BY_CLUB" } });
    expect(gd.map((d) => [d.channel, d.status, d.toAddress]).sort()).toEqual([["EMAIL", "QUEUED", "gopal@example.com"], ["WHATSAPP_MANUAL", "QUEUED", "919876540011"]]);
    // The worker delivers: the email says what, where, when, how much and where to choose; push deep-links.
    expect(await flushDeliveries()).toMatchObject({ failed: 0 });
    const mail = mails.find((x) => x.to === m.member.email && x.subject.startsWith("Cancelled by the club"))!;
    expect(mail.subject).toMatch(/^Cancelled by the club: Court 1, .+ 18:00–19:00$/);
    expect(mail.text).toMatch(/^Hi Maint,/);
    expect(mail.text).toContain(b.bookingCode);
    expect(mail.text).toMatch(/Maintenance: net repair/);
    expect(mail.text).toMatch(/You paid ₹550\. Choose in My bookings by .*Reschedule .*Refund/);
    expect(mail.text).toContain("http://localhost:3200/portal/bookings");
    expect(pushes.map((p) => JSON.parse(p))).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/^Cancelled by the club: Court 1/), url: "/portal/bookings" }));
    expect(mails.some((x) => x.to === "gopal@example.com")).toBe(true);
    expect(await rows(m.memberId, "BOOKING_CANCELLED_BY_CLUB")).toEqual(["EMAIL:SENT", "IN_APP:SENT", "PUSH:SENT", "WHATSAPP_API:SKIPPED", "WHATSAPP_MANUAL:QUEUED"]);
    await expectIntegrity();
  });

  it("social play cancelled by the staff: members on every channel, guests by email/phone, with the refund in the message", async () => {
    const m = await reachable("Social Sana");
    const s = await createSocialSession(w.actors.MANAGER, { title: "Tuesday social", date: "2026-10-13", startTime: "19:00", endTime: "21:00", courtIds: [w.courts["Court 2"].id], capacityPerCourt: 8 });
    const id = s.sessions[0].id;
    await joinSession(w.actors.FRONT_DESK, { sessionId: id, player: { memberId: m.memberId }, payment: { kind: "COUNTER", method: "CASH" } });
    await joinSession(w.actors.FRONT_DESK, { sessionId: id, player: { guest: { name: "Social Guest", phone: "9876540012" } } });
    await cancelSocialSession(w.actors.MANAGER, id, "coach unwell");
    expect(await rows(m.memberId, "BOOKING_CANCELLED_BY_CLUB")).toEqual(ALL);
    const d = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED_BY_CLUB", channel: "EMAIL" } });
    expect(d.body).toMatch(/Reason: coach unwell\. Your ₹\d[\d,]* (has been refunded|is refunded)/);
    // The cancellation message carries the refund: no second "refund" message for the same money.
    expect(await prisma.notificationDelivery.count({ where: { memberId: m.memberId, event: { in: ["REFUND_APPROVED", "REFUND_COMPLETED"] } } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { guestId: { not: null }, event: "BOOKING_CANCELLED_BY_CLUB", channel: "WHATSAPP_MANUAL", toAddress: "919876540012" } })).toBe(1);
    await expectIntegrity();
  });

  it("a booking cancelled by the desk: every channel; a member cancelling their own gets the in-app/email confirmation only", async () => {
    const m = await reachable("Desk Dev");
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await cancelBooking(w.actors.FRONT_DESK, b.bookingId, { reason: "member called" });
    expect(await rows(m.memberId, "BOOKING_CANCELLED")).toEqual(ALL);
    const own = await book(w, { time: "19:00", players: [{ memberId: m.memberId }] });
    await cancelBooking(m.actor, own.bookingId);
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: { startsWith: `booking-cancelled:${own.bookingId}` } } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: m.member.userId!, type: "BOOKING_CANCELLED" } })).toBe(2);
  });

  it("rescheduled after a club cancellation, and the automatic refund when nobody chose", async () => {
    const a = await reachable("Move Manu");
    const c = await reachable("Quiet Qamar");
    const ba = await book(w, { time: "18:00", players: [{ memberId: a.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    const bc = await book(w, { time: "19:00", players: [{ memberId: c.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 1"].id], date: "2026-10-12", startTime: "17:00", endTime: "21:00", reason: "WET_COURT", note: "" });
    const cca = await prisma.clubCancellation.findUniqueOrThrow({ where: { bookingId: ba.bookingId } });
    const moved = await rescheduleClubCancellation(a.actor, cca.id, { courtId: w.courts["Court 2"].id, date: "2026-10-14", startTime: "18:00" });
    expect(await rows(a.memberId, "BOOKING_RESCHEDULED")).toEqual(ALL);
    const rd = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: a.memberId, event: "BOOKING_RESCHEDULED", channel: "EMAIL" } });
    expect(rd.body).toContain(moved.booking.bookingCode);
    expect(rd.body).toMatch(/Court 2, .*18:00–19:00.*nothing more to pay/);
    // CC-6: no choice by the deadline → refunded, and the member is told why and how to get the money.
    clock.set(istToUtc("2026-10-19", "10:01"));
    expect((await runDailyJobs()).clubCancellations.refunded).toBe(1);
    expect(await rows(c.memberId, "BOOKING_AUTO_REFUNDED")).toEqual(ALL);
    const ad = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: c.memberId, event: "BOOKING_AUTO_REFUNDED", channel: "EMAIL" } });
    expect(ad.body).toMatch(new RegExp(`No new time was chosen for ${bc.bookingCode}.*refunded in full: ₹150\\. ₹150 is ready at the front desk`));
    expect(await prisma.notificationDelivery.count({ where: { memberId: c.memberId, event: "REFUND_APPROVED" } })).toBe(0);
    // Paid out at the desk later → "Refund completed" on every channel.
    const req = await prisma.refundRequest.findFirstOrThrow({ where: { billId: bc.billId } });
    await payOutRefund(w.actors.FRONT_DESK, req.id, { method: "CASH" });
    expect(await rows(c.memberId, "REFUND_COMPLETED")).toEqual(ALL);
    await expectIntegrity();
  });
});

describe("dues and membership", () => {
  it("dues: unpaid bill reminders, and an invoice before its due date, on the day and when overdue — each once", async () => {
    const m = await reachable("Dues Daksh", { pay: false });
    clock.set(istToUtc("2026-10-15", "10:00"));
    expect((await runDuesReminders()).sent).toBe(1);
    expect(await rows(m.memberId, "DUES_REMINDER", "dues:")).toEqual(ALL);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: m.billId!, method: "CASH", amount: 200000 });

    clock.set(istToUtc("2026-10-12", "10:00"));
    const d = await createDraft(w.actors.ACCOUNTANT, { memberId: m.memberId, lines: [{ kind: "MANUAL", description: "Coaching block — October", qty: 1, unitPrice: 300000 }] });
    const inv = await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
    const due = inv.dueDate!.toISOString().slice(0, 10);
    const at = (day: string) => clock.set(istToUtc(day, "00:05"));
    at(addDays(due, -INVOICE_DUE_SOON_DAYS - 1));
    expect((await runInvoiceDueReminders()).sent).toBe(0);
    at(addDays(due, -INVOICE_DUE_SOON_DAYS));
    expect((await runInvoiceDueReminders()).sent).toBe(1);
    expect((await runInvoiceDueReminders()).sent).toBe(0);
    at(due);
    expect((await runInvoiceDueReminders()).sent).toBe(1);
    expect((await runDuesReminders()).sent).toBe(0); // not overdue yet: no generic dues reminder on top
    at(addDays(due, 1));
    expect((await runInvoiceDueReminders()).sent).toBe(1);
    for (const step of ["SOON", "TODAY", "OVERDUE"]) expect([step, await rows(m.memberId, "DUES_REMINDER", `invoice-due:${inv.id}:${step}`)]).toEqual([step, ALL]);
    const overdue = await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: `invoice-due:${inv.id}:OVERDUE`, channel: "EMAIL" } });
    expect(overdue.title).toMatch(new RegExp(`^Overdue: ₹[\\d,]+ for invoice ${inv.number!.replace(/\//g, "\\/")}$`));
    expect(overdue.link).toBe("/portal/invoices");
    // The member hears it through the channel log, not a second time through the old email outbox.
    expect(await markOverdueInvoices()).toBe(1);
    expect(await prisma.emailOutbox.count({ where: { to: m.member.email!, subject: { contains: "overdue" } } })).toBe(0);
  });

  it("membership: 7 days and 1 day before expiry, expired, and renewed — every channel", async () => {
    const m = await reachable("Expiry Ekta");
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: m.membershipId! } });
    const end = ms.endDate.toISOString().slice(0, 10);
    for (const [day, type] of [[addDays(end, -7), "D7"], [addDays(end, -1), "D1"], [addDays(end, 1), "EXPIRED"]] as const) {
      clock.set(istToUtc(day, "00:05"));
      await runMembershipJob();
      expect([type, await rows(m.memberId, "MEMBERSHIP_EXPIRY", `membership-reminder:${ms.id}:${type}:`)]).toEqual([type, ALL]);
    }
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: m.memberId, planCode: "SILVER", months: 1 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: ren.billId, method: "UPI", amount: ren.total, reference: utr() });
    expect(await rows(m.memberId, "MEMBERSHIP_RENEWED", `membership-paid:${ren.membershipId}`)).toEqual(ALL);
  });
});

describe("refunds", () => {
  it("asked for, approved (collect at the desk), paid out, rejected, and completed through the gateway", async () => {
    const m = await reachable("Refund Rhea");
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, guest("Pal Pia")], payment: { kind: "COUNTER", method: "CASH" } });
    const req = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 15000, reason: "SERVICE_ISSUE", note: "lights failed" });
    expect(await rows(m.memberId, "REFUND_REQUESTED")).toEqual(ALL);
    await approveRefund(w.actors.MANAGER, req.id);
    expect(await rows(m.memberId, "REFUND_APPROVED")).toEqual(ALL);
    const ap = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "REFUND_APPROVED", channel: "EMAIL" } });
    expect(ap.body).toMatch(new RegExp(`${req.code} · ₹150 for your court booking ${b.bookingCode} \\(Court 1, .*\\)\\. It is ready at the front desk`));
    await payOutRefund(w.actors.FRONT_DESK, req.id, { method: "CASH" });
    expect(await rows(m.memberId, "REFUND_COMPLETED")).toEqual(ALL);

    const r2 = await requestRefund(w.actors.FRONT_DESK, { billId: b.billId, amount: 10000, reason: "GOODWILL", note: "sorry" });
    await rejectRefund(w.actors.MANAGER, r2.id, "already refunded the court fee");
    expect(await rows(m.memberId, "REFUND_REJECTED")).toEqual(ALL);
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "REFUND_REJECTED", channel: "EMAIL" } })).body).toMatch(/Reason: already refunded the court fee/);

    // Online: the gateway pays at once → only "completed", never a stale "approved".
    const o = await book(w, { time: "19:00", players: [{ memberId: m.memberId }], payment: { kind: "LATER" } });
    const s = await startOnlinePayment(w.actors.FRONT_DESK, o.billId, "/x");
    const gp = testGateway.newGatewayPaymentId();
    await verifyOnlinePayment(s.paymentId, { gatewayPaymentId: gp, outcome: "SUCCESS", signature: testGateway.sign(s.paymentId, gp, "SUCCESS") });
    const r3 = await requestRefund(w.actors.FRONT_DESK, { billId: o.billId, amount: 15000, reason: "SERVICE_ISSUE", note: "rain" });
    expect((await approveRefund(w.actors.MANAGER, r3.id)).status).toBe("COMPLETED");
    expect(await prisma.notificationDelivery.count({ where: { dedupeKey: `refund-approved:${r3.id}` } })).toBe(0);
    expect(await prisma.notificationDelivery.findMany({ where: { dedupeKey: `refund-completed:${r3.id}` } }).then((d) => d.map((x) => `${x.channel}:${x.status}`).sort())).toEqual(ALL);
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { dedupeKey: `refund-completed:${r3.id}`, channel: "EMAIL" } })).body).toMatch(/\(online\)\. Online refunds go back to the card or account you paid with/);
    await expectIntegrity();
  });
});

describe("preferences and guests", () => {
  it("a member who turned email, push and WhatsApp off gets the bell only; the log says why", async () => {
    const m = await reachable("Quiet Qila");
    await setMyPreferences(m.actor, { email: false, push: false, whatsapp: false });
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    await cancelBooking(w.actors.FRONT_DESK, b.bookingId, { reason: "court repair" });
    const d = await prisma.notificationDelivery.findMany({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED" } });
    expect(Object.fromEntries(d.map((x) => [x.channel, [x.status, x.error]]))).toEqual({
      IN_APP: ["SENT", null], PUSH: ["SKIPPED", "Turned off by the member"], EMAIL: ["SKIPPED", "Turned off by the member"],
      WHATSAPP_API: ["SKIPPED", "Turned off by the member"], WHATSAPP_MANUAL: ["SKIPPED", "Turned off by the member"],
    });
    // Just email back on: only email is added for the next message.
    await setMyPreferences(m.actor, { email: true });
    await requestRefund(w.actors.FRONT_DESK, { billId: (await book(w, { time: "19:00", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } })).billId, amount: 15000, reason: "GOODWILL", note: "sorry" });
    expect(await rows(m.memberId, "REFUND_REQUESTED")).toEqual(["EMAIL:QUEUED", "IN_APP:SENT", "PUSH:SKIPPED", "WHATSAPP_API:SKIPPED", "WHATSAPP_MANUAL:SKIPPED"]);
  });

  it("a trial guest whose booking the club cancels is told by email and on their phone", async () => {
    const { createTrialBooking } = await import("@/server/services/crm");
    const t = await createTrialBooking({ consent: true, name: "Trial Tara", phone: "9876540013", email: "tara@example.com", courtId: w.courts["Court 3"].id, date: "2026-10-13", startTime: "18:00" });
    await closeCourts(w.actors.MANAGER, { courtIds: [w.courts["Court 3"].id], date: "2026-10-13", startTime: "17:00", endTime: "20:00", reason: "WEATHER", note: "storm warning" });
    const g = await prisma.guest.findFirstOrThrow({ where: { phone: "9876540013" } });
    const d = await prisma.notificationDelivery.findMany({ where: { guestId: g.id, event: "BOOKING_CANCELLED_BY_CLUB" } });
    expect(d.map((x) => `${x.channel}:${x.status}:${x.toAddress}`).sort()).toEqual(["EMAIL:QUEUED:tara@example.com", "WHATSAPP_MANUAL:QUEUED:919876540013"]);
    expect(d[0].body).toContain(t.bookingCode);
    await flushDeliveries();
    expect(mails.find((x) => x.to === "tara@example.com")?.text).toMatch(/^Hi Trial,[\s\S]*Weather: storm warning/);
  });
});

describe("the worker delivers", () => {
  it("a passing failure is retried with backoff and logged; a hard bounce fails at once; two runs never send twice", async () => {
    const m = await reachable("Retry Ravi");
    const b = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    await flushDeliveries(); // the membership confirmation from sign-up
    mails.length = 0;
    await cancelBooking(w.actors.FRONT_DESK, b.bookingId, { reason: "court repair" });
    let fail = true;
    setMailTransportForTests({ sendMail: async (x) => { if (fail) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); mails.push(x as never); } });
    const email = () => prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED", channel: "EMAIL" } });
    expect(await flushDeliveries()).toEqual({ sent: 1, failed: 1 }); // push went, email didn't
    expect(await email()).toMatchObject({ status: "QUEUED", error: expect.stringMatching(/^Attempt 1 of 4 failed, trying again in 5 min: connect ETIMEDOUT/) });
    expect(await prisma.messageLog.count({ where: { to: m.member.email!, status: "FAILED", error: { contains: "ETIMEDOUT" } } })).toBe(1);
    expect(await flushDeliveries()).toEqual({ sent: 0, failed: 0 }); // backing off
    clock.set(new Date(clock.now().getTime() + 6 * 60_000));
    expect(await flushDeliveries()).toEqual({ sent: 0, failed: 1 });
    expect((await email()).error).toMatch(/^Attempt 2 of 4 failed, trying again in 30 min/);
    fail = false;
    clock.set(new Date(clock.now().getTime() + 31 * 60_000));
    // Two runs at once: the row is claimed by one of them.
    const [x, y] = await Promise.all([flushDeliveries(), flushDeliveries()]);
    expect(x.sent + y.sent).toBe(1);
    expect(mails).toHaveLength(1);
    expect(await email()).toMatchObject({ status: "SENT", error: expect.stringMatching(/^Sent on attempt 3/) });

    // A transient failure every time gives up after the last attempt; a 5xx bounce fails at once.
    await cancelBooking(w.actors.FRONT_DESK, (await book(w, { time: "19:00", players: [{ memberId: m.memberId }] })).bookingId);
    fail = true;
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
      await flushDeliveries();
      clock.set(new Date(clock.now().getTime() + 3 * 3600_000));
    }
    const last = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED", channel: "EMAIL", status: { not: "SENT" } } });
    expect([last.status, last.error]).toEqual(["FAILED", "connect ETIMEDOUT (gave up after 4 attempts)"]);
    setMailTransportForTests({ sendMail: async () => { throw Object.assign(new Error("550 5.1.1 mailbox unavailable"), { responseCode: 550 }); } });
    await cancelBooking(w.actors.FRONT_DESK, (await book(w, { date: "2026-10-14", time: "20:00", players: [{ memberId: m.memberId }] })).bookingId);
    await flushDeliveries();
    const hard = await prisma.notificationDelivery.findFirstOrThrow({ where: { memberId: m.memberId, event: "BOOKING_CANCELLED", channel: "EMAIL" }, orderBy: { createdAt: "desc" } });
    expect([hard.status, hard.error]).toEqual(["FAILED", "550 5.1.1 mailbox unavailable"]);
  });
});
