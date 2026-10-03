import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { cancelBooking, changePlayers, createMaintenance, getAvailability, markNoShowsAndCompletions } from "@/server/services/booking";
import { createSocialSession, joinSession, leaveSession } from "@/server/services/social";
import { checkIn } from "@/server/services/checkin";
import { recordCounterPayment } from "@/server/services/payments";
import { upgradeMembership } from "@/server/services/membership";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026 10:00 IST
});

describe("Phase 3 — slots and the court guarantee (CT-3, BK-1, BK-2)", () => {
  it("BK-1: 18:00–19:00 then 18:30–19:30 on the same court → SLOT_TAKEN naming the booking; 19:00–20:00 is fine (half-open)", async () => {
    const first = await book(w, { time: "18:00", players: [guest("Walk-in One")] });
    await expect(book(w, { time: "18:30", players: [guest("Walk-in Two")] })).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      message: `Court 1 is already booked 18:00–19:00 (${first.bookingCode}).`,
    });
    const adjacent = await book(w, { time: "19:00", players: [guest("Walk-in Three")] });
    expect(adjacent.status).toBe("CONFIRMED");
    // A different court at the same time is fine.
    expect((await book(w, { court: "Court 2", time: "18:30", players: [guest("Walk-in Four")] })).status).toBe("CONFIRMED");
  });

  it("CT-3: 18:15 → INVALID_SLOT; 21:30 → INVALID_SLOT (ends after close); 05:30 → INVALID_SLOT", async () => {
    await expect(book(w, { time: "18:15", players: [guest("Gita")] })).rejects.toMatchObject({ code: "INVALID_SLOT" });
    await expect(book(w, { time: "21:30", players: [guest("Gita")] })).rejects.toMatchObject({ code: "INVALID_SLOT", message: expect.stringMatching(/outside opening hours 06:00–22:00/) });
    await expect(book(w, { time: "05:30", players: [guest("Gita")] })).rejects.toMatchObject({ code: "INVALID_SLOT" });
    expect((await book(w, { time: "21:00", players: [guest("Gita")] })).status).toBe("CONFIRMED");
  });

  it("BK-2 IN_PAST: staff get a 15-minute grace, online members do not", async () => {
    clock.set(istToUtc("2026-10-12", "18:10"));
    const m = await makeMember(w, { name: "Late Lalit", plan: "SILVER" });
    await expect(book(w, { time: "18:00", players: [{ memberId: m.memberId }], actor: m.actor, channel: "ONLINE_MEMBER" })).rejects.toMatchObject({ code: "IN_PAST" });
    expect((await book(w, { time: "18:00", players: [guest("Walk-in Wendy")], channel: "WALK_IN" })).status).toBe("CONFIRMED");
    clock.set(istToUtc("2026-10-12", "18:16"));
    await expect(book(w, { court: "Court 2", time: "18:00", players: [guest("Too Late")], channel: "WALK_IN" })).rejects.toMatchObject({ code: "IN_PAST" });
  });

  it("BK-2 COURT_INACTIVE and PLAYERS_INVALID", async () => {
    await prisma.court.update({ where: { id: w.courts["Court 3"].id }, data: { active: false } });
    await expect(book(w, { court: "Court 3", time: "18:00", players: [guest("A1")] })).rejects.toMatchObject({ code: "COURT_INACTIVE" });
    await expect(book(w, { time: "18:00", players: [guest("P1"), guest("P2"), guest("P3"), guest("P4"), guest("P5")] })).rejects.toMatchObject({ code: "PLAYERS_INVALID" });
    const m = await makeMember(w, { name: "Dupe Dan", plan: "SILVER" });
    await expect(book(w, { time: "18:00", players: [{ memberId: m.memberId }, { memberId: m.memberId }] })).rejects.toMatchObject({ code: "PLAYERS_INVALID" });
  });

  it("E-08 OUTSIDE_BOOKING_WINDOW: walk-in 1 day, Silver 5 days, Gold 7 days", async () => {
    await expect(book(w, { date: "2026-10-14", time: "18:00", players: [guest("Far Ahead")] })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
    expect((await book(w, { date: "2026-10-13", time: "18:00", players: [guest("Tomorrow Tom")] })).status).toBe("CONFIRMED");
    const silver = await makeMember(w, { name: "Silver Sia", plan: "SILVER" });
    await expect(book(w, { date: "2026-10-18", time: "18:00", players: [{ memberId: silver.memberId }] })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
    expect((await book(w, { date: "2026-10-17", time: "18:00", players: [{ memberId: silver.memberId }] })).status).toBe("CONFIRMED");
    const gold = await makeMember(w, { name: "Gold Gia", plan: "GOLD" });
    expect((await book(w, { date: "2026-10-19", time: "18:00", players: [{ memberId: gold.memberId }] })).status).toBe("CONFIRMED");
  });
});

describe("Phase 3 — daily limit and player conflicts (BK-3, BK-4)", () => {
  it("BK-4: a third play for a member → DAILY_LIMIT_REACHED naming the two existing bookings", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const a = await book(w, { time: "11:00", players: [{ memberId: kiran.memberId }] });
    const b = await book(w, { court: "Court 2", time: "12:00", players: [{ memberId: kiran.memberId }] });
    await expect(book(w, { court: "Court 3", time: "18:00", players: [{ memberId: kiran.memberId }] })).rejects.toMatchObject({
      code: "DAILY_LIMIT_REACHED",
      message: expect.stringContaining(`Kiran already has 2 plays on 12 Oct 2026: ${a.bookingCode} (Court 1 11:00–12:00), ${b.bookingCode} (Court 2 12:00–13:00)`),
    });
  });

  it("BK-4: a partner who already has 2 plays is rejected even though they aren't the booker", async () => {
    const booker = await makeMember(w, { name: "Booker Bea", plan: "SILVER" });
    const partner = await makeMember(w, { name: "Partner Pat", plan: "SILVER" });
    await book(w, { time: "11:00", players: [{ memberId: partner.memberId }] });
    await book(w, { court: "Court 2", time: "12:30", players: [{ memberId: partner.memberId }] });
    await expect(book(w, { court: "Court 3", time: "18:00", players: [{ memberId: booker.memberId }, { memberId: partner.memberId }] })).rejects.toMatchObject({
      code: "DAILY_LIMIT_REACHED",
      message: expect.stringMatching(/^Partner Pat already has 2 plays/),
    });
  });

  it("BK-4: cancelling one restores the allowance; a social join counts as a play; guests are unlimited", async () => {
    const m = await makeMember(w, { name: "Social Sam", plan: "SILVER" });
    const ses = await createSocialSession(w.actors.MANAGER, { title: "Monday Mixer", courtIds: [w.courts["Court 4"].id], date: "2026-10-12", startTime: "19:00", endTime: "21:00" });
    await joinSession(w.actors.FRONT_DESK, { sessionId: ses.sessions[0].id, player: { memberId: m.memberId } });
    const b1 = await book(w, { time: "12:00", players: [{ memberId: m.memberId }] });
    await expect(book(w, { court: "Court 2", time: "15:00", players: [{ memberId: m.memberId }] })).rejects.toMatchObject({ code: "DAILY_LIMIT_REACHED" });
    await cancelBooking(w.actors.FRONT_DESK, b1.bookingId);
    expect((await book(w, { court: "Court 2", time: "15:00", players: [{ memberId: m.memberId }] })).status).toBe("CONFIRMED");
    const g = await prisma.guest.create({ data: { name: "Busy Guest" } });
    for (const t of ["11:00", "13:00", "15:00"]) {
      expect((await book(w, { court: "Net A", time: t, players: [{ guestId: g.id }] })).status).toBe("CONFIRMED");
    }
  });

  it("PLAYER_TIME_CONFLICT: the same member on two courts at overlapping times", async () => {
    const m = await makeMember(w, { name: "Double Dev", plan: "GOLD" });
    const first = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    await expect(book(w, { court: "Court 2", time: "18:30", players: [{ memberId: m.memberId }] })).rejects.toMatchObject({
      code: "PLAYER_TIME_CONFLICT",
      message: expect.stringContaining(first.bookingCode),
    });
  });
});

describe("Phase 3 — pricing on bookings (PR-4, MB-9, BK-6)", () => {
  it("Gold ₹0 (auto PAID), Silver ₹150, Junior ₹100, walk-in ₹400; a mixed group sums per player", async () => {
    const gold = await makeMember(w, { name: "Rahul", plan: "GOLD" });
    const silver = await makeMember(w, { name: "Neha", plan: "SILVER" });
    const junior = await makeMember(w, { name: "Aarav", plan: "JUNIOR", dob: "2011-01-01" });
    const solo = await book(w, { time: "11:00", players: [{ memberId: gold.memberId }] });
    expect(solo.total).toBe(0);
    expect(solo.billStatus).toBe("PAID");
    const mixed = await book(w, { court: "Court 2", time: "11:00", players: [{ memberId: silver.memberId }, { memberId: junior.memberId }, guest("Friend")] });
    expect(mixed.players.map((p) => [p.tier, p.fee])).toEqual([["SILVER", 15000], ["JUNIOR", 10000], ["WALK_IN", 40000]]);
    expect(mixed.total).toBe(65000);
    expect(mixed.billStatus).toBe("UNPAID");
  });

  it("demo step 2: Silver + walk-in friend = ₹150 + ₹400 = ₹550 with explanations", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const r = await book(w, { time: "18:00", players: [{ memberId: kiran.memberId }, guest("Kiran's friend")] });
    expect(r.total).toBe(55000);
    expect(r.players[0].explanation).toMatch(/Silver member rate · ₹150/);
    expect(r.players[1].explanation).toMatch(/Walk-in rate · ₹400/);
  });

  it("MB-9: a plan change keeps existing booking prices", async () => {
    const m = await makeMember(w, { name: "Snap Shot", plan: "SILVER" });
    const r = await book(w, { date: "2026-10-13", time: "18:00", players: [{ memberId: m.memberId }] });
    const up = await upgradeMembership(w.actors.FRONT_DESK, { memberId: m.memberId, planCode: "GOLD", months: 1 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: up.billId, method: "CASH", amount: up.total });
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
    expect(bill.total).toBe(15000);
    const bp = await prisma.bookingPlayer.findFirstOrThrow({ where: { bookingId: r.bookingId } });
    expect(bp.tierSnapshot).toBe("SILVER");
  });

  it("idempotency key replay → same booking, no duplicate", async () => {
    const a = await book(w, { time: "18:00", players: [guest("Clicky Clara")] }, "booking-key-1");
    const b = await book(w, { time: "18:00", players: [guest("Clicky Clara")] }, "booking-key-1");
    expect(b.bookingId).toBe(a.bookingId);
    expect(await prisma.booking.count()).toBe(1);
  });
});

describe("Phase 3 — cancellation (BK-7) and RBAC", () => {
  it("BK-7: cancelled ≥ 2h before → full refund + negative ledger entry; the court and the daily count are freed", async () => {
    const m = await makeMember(w, { name: "Cancel Cal", plan: "SILVER" });
    const r = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, guest("Pal")], payment: { kind: "COUNTER", method: "UPI", reference: "UTR1" } });
    expect(r.billStatus).toBe("PAID");
    const c = await cancelBooking(w.actors.FRONT_DESK, r.bookingId);
    expect(c.refunded).toBe(55000);
    const ledger = await prisma.ledgerEntry.findMany({ where: { billId: r.billId }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.source, l.amount])).toEqual([["COURTS", 55000], ["COURTS", -55000]]);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } })).status).toBe("REFUNDED");
    expect((await book(w, { time: "18:00", players: [guest("Next Person")] })).status).toBe("CONFIRMED");
    await expectIntegrity();
  });

  it("BK-7: cancelled < 2h before → no refund; an unpaid balance stays due", async () => {
    const paid = await book(w, { time: "11:00", players: [guest("Paid Pia")], payment: { kind: "COUNTER", method: "CASH" } });
    const unpaid = await book(w, { court: "Court 2", time: "11:00", players: [guest("Unpaid Uri")] });
    clock.set(istToUtc("2026-10-12", "10:30"));
    expect((await cancelBooking(w.actors.FRONT_DESK, paid.bookingId)).refunded).toBe(0);
    await cancelBooking(w.actors.FRONT_DESK, unpaid.bookingId);
    const ub = await prisma.bill.findUniqueOrThrow({ where: { id: unpaid.billId } });
    expect(ub.closedAt).toBeNull();
    expect(ub.total - ub.amountPaid).toBe(40000);
    expect(await prisma.ledgerEntry.count({ where: { billId: paid.billId, amount: { lt: 0 } } })).toBe(0);
    await expectIntegrity();
  });

  it("RBAC: a MEMBER cancelling someone else's booking → FORBIDDEN; their own works", async () => {
    const a = await makeMember(w, { name: "Owner Ola", plan: "GOLD" });
    const b = await makeMember(w, { name: "Other Obi", plan: "GOLD" });
    const r = await book(w, { time: "18:00", players: [{ memberId: a.memberId }], actor: a.actor, channel: "ONLINE_MEMBER" });
    await expect(cancelBooking(b.actor, r.bookingId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(book(w, { time: "19:00", players: [{ memberId: a.memberId }], actor: b.actor, channel: "ONLINE_MEMBER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await cancelBooking(a.actor, r.bookingId)).status).toBe("CANCELLED");
    await expect(cancelBooking(a.actor, r.bookingId)).rejects.toMatchObject({ code: "CANCEL_NOT_ALLOWED" });
  });

  it("BK-8: changing players re-checks the rules and re-prices; removing a payer in time refunds the difference", async () => {
    const m = await makeMember(w, { name: "Change Chen", plan: "SILVER" });
    const r = await book(w, { time: "18:00", players: [{ memberId: m.memberId }, guest("Drop Me")], payment: { kind: "COUNTER", method: "CARD" } });
    expect(r.total).toBe(55000);
    const res = await changePlayers(w.actors.FRONT_DESK, r.bookingId, { players: [{ memberId: m.memberId }] });
    expect(res.refunded).toBe(40000);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
    expect(bill.total).toBe(15000);
    const add = await changePlayers(w.actors.FRONT_DESK, r.bookingId, { players: [{ memberId: m.memberId }, guest("New Pal")] });
    expect(add.due).toBe(40000);
    await expectIntegrity();
  });
});

describe("Phase 3 — social play (SP-1…SP-4)", () => {
  it("SP-4: a regular booking overlapping a social session → SLOT_TAKEN", async () => {
    await createSocialSession(w.actors.MANAGER, { title: "Friday Social", courtIds: [w.courts["Court 1"].id, w.courts["Court 2"].id], date: "2026-10-16", startTime: "19:00", endTime: "22:00" });
    const g = await makeMember(w, { name: "Gold Gus", plan: "GOLD" });
    await expect(book(w, { court: "Court 2", date: "2026-10-16", time: "20:30", players: [{ memberId: g.memberId }] })).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      message: "Court 2 is already held for social play “Friday Social” 19:00–22:00.",
    });
  });

  it("SP-2: creating social play over an existing booking is rejected with the conflict listed", async () => {
    const r = await book(w, { time: "19:00", players: [guest("In The Way")] });
    await expect(createSocialSession(w.actors.MANAGER, { title: "Clash", courtIds: [w.courts["Court 1"].id], date: "2026-10-12", startTime: "18:00", endTime: "21:00" })).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      message: expect.stringContaining(r.bookingCode),
    });
    await expect(createSocialSession(w.actors.FRONT_DESK, { title: "Nope", courtIds: [w.courts["Court 3"].id], date: "2026-10-12", startTime: "18:00", endTime: "21:00" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("SP-3: capacity full → SESSION_FULL; fees by tier; a member and a guest can join; E-22 weekly series", async () => {
    const ses = await createSocialSession(w.actors.MANAGER, { title: "Tiny Social", courtIds: [w.courts["Court 4"].id], date: "2026-10-12", startTime: "19:00", endTime: "21:00", capacityPerCourt: 2, repeatWeeks: 3 });
    expect(ses.sessions.map((s) => s.date)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    const m = await makeMember(w, { name: "Joiner Jo", plan: "SILVER" });
    const j1 = await joinSession(w.actors.FRONT_DESK, { sessionId: ses.sessions[0].id, player: { memberId: m.memberId } });
    expect(j1.fee).toBe(10000);
    const j2 = await joinSession(w.actors.FRONT_DESK, { sessionId: ses.sessions[0].id, player: guest("Guest Gita") });
    expect(j2.fee).toBe(25000);
    await expect(joinSession(w.actors.FRONT_DESK, { sessionId: ses.sessions[0].id, player: guest("One Too Many") })).rejects.toMatchObject({ code: "SESSION_FULL" });
    await leaveSession(w.actors.FRONT_DESK, j2.participantId);
    expect((await joinSession(w.actors.FRONT_DESK, { sessionId: ses.sessions[0].id, player: guest("Now Fits") })).fee).toBe(25000);
  });
});

describe("Phase 3 — check-in, no-shows, availability, maintenance (CI-2, BK-6, BK-9, BK-10, BK-12, CT-4)", () => {
  it("BK-6/CI-2: check-in is blocked while unpaid (PAYMENT_DUE), opens 30 minutes before, writes a visit", async () => {
    const m = await makeMember(w, { name: "Check Chris", plan: "SILVER" });
    const r = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    const bp = await prisma.bookingPlayer.findFirstOrThrow({ where: { bookingId: r.bookingId } });
    await expect(checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/opens 30 minutes/) });
    clock.set(istToUtc("2026-10-12", "17:45"));
    await expect(checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id })).rejects.toMatchObject({ code: "PAYMENT_DUE", message: expect.stringMatching(/₹150 unpaid/) });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: r.billId, method: "CASH", amount: 15000 });
    await checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id });
    expect(await prisma.visit.count({ where: { memberId: m.memberId } })).toBe(1);
  });

  it("BK-9/BK-10: ended sessions become NO_SHOW (no check-in) or COMPLETED; no-shows still count toward the limit", async () => {
    const m = await makeMember(w, { name: "Ghost Gail", plan: "GOLD" });
    const n = await makeMember(w, { name: "Present Pete", plan: "GOLD" });
    const r1 = await book(w, { time: "11:00", players: [{ memberId: m.memberId }] });
    const r2 = await book(w, { court: "Court 2", time: "11:00", players: [{ memberId: n.memberId }] });
    clock.set(istToUtc("2026-10-12", "11:05"));
    const bp = await prisma.bookingPlayer.findFirstOrThrow({ where: { bookingId: r2.bookingId } });
    await checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id });
    clock.set(istToUtc("2026-10-12", "12:05"));
    expect(await markNoShowsAndCompletions()).toMatchObject({ noShows: 1, completed: 1 });
    expect(await markNoShowsAndCompletions()).toMatchObject({ noShows: 0, completed: 0 });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: r1.bookingId } })).status).toBe("NO_SHOW");
    await book(w, { time: "15:00", players: [{ memberId: m.memberId }] });
    await expect(book(w, { time: "17:00", players: [{ memberId: m.memberId }] })).rejects.toMatchObject({ code: "DAILY_LIMIT_REACHED" });
  });

  it("BK-12: availability needs both halves free; staff see names, the public sees only Booked/Social/Maintenance/Free", async () => {
    await book(w, { time: "18:00", players: [guest("Visible Vik")] });
    await createMaintenance(w.actors.MANAGER, { courtId: w.courts["Court 2"].id, date: "2026-10-12", startTime: "14:00", endTime: "16:00", note: "resurfacing" });
    const staff = await getAvailability("STAFF", "2026-10-12");
    const pub = await getAvailability("PUBLIC", "2026-10-12");
    const slot = (a: typeof staff, court: string, t: string) => a.dates[0].courts.find((c) => c.name === court)!.slots.find((s) => s.time === t)!;
    expect(slot(staff, "Court 1", "18:00").label).toBe("Visible Vik");
    expect(slot(pub, "Court 1", "18:00").label).toBe("Booked");
    expect(slot(pub, "Court 1", "17:30").bookable).toBe(false); // 17:30–18:30 overlaps
    expect(slot(pub, "Court 1", "19:00").bookable).toBe(true);
    expect(slot(pub, "Court 2", "14:30").label).toBe("Maintenance");
    expect(slot(pub, "Court 1", "21:30").bookable).toBe(false); // would end after close
    expect(slot(pub, "Court 1", "09:00").past).toBe(true);
    await expect(book(w, { court: "Court 2", time: "15:30", players: [guest("Blocked")] })).rejects.toMatchObject({ code: "SLOT_TAKEN", message: expect.stringMatching(/maintenance 14:00–16:00 \(resurfacing\)/) });
  });
});
