import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import {
  cancelMembership,
  createMember,
  effectiveStatus,
  renewMembership,
  runMembershipJob,
  scheduleDowngrade,
  upgradeCredit,
  upgradeMembership,
} from "@/server/services/membership";
import { lookupByCard, member360, searchMembers, memberCard } from "@/server/services/members";
import { recordCounterPayment } from "@/server/services/payments";
import { quoteCourt } from "@/server/services/pricing";
import { makeWorld, T0, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const courtFee = async (memberId: string, date: string) => {
  const q = await quoteCourt(prisma, { sport: "TENNIS", date, courtName: "Court 1", timeLabel: "18:00", players: [{ memberId, name: "x" }] });
  return q.players[0];
};

describe("Phase 2 — sign-up (MB-1, R-01) and activation (MB-3, IN-4)", () => {
  it("MB-1: name, 10-digit Indian mobile and date of birth are required", async () => {
    await expect(createMember(w.actors.FRONT_DESK, { name: "Kiran", phone: "12345", dob: "1995-01-01" })).rejects.toThrow(/10-digit Indian mobile/);
    await expect(createMember(w.actors.FRONT_DESK, { name: "Kiran", phone: "9876543210", dob: "" })).rejects.toThrow();
  });

  it("MB-3/IN-4: Silver 1 month paid by UPI → ACTIVE, tax invoice with FY number, MEMBERSHIP ledger entry", async () => {
    const r = await makeMember(w, { name: "Kiran Shah", plan: "SILVER" });
    expect(r.membershipStatus).toBe("ACTIVE");
    expect(r.billStatus).toBe("PAID");
    expect(r.memberCode).toMatch(/^CC-\d{6}$/);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { memberId: r.memberId } });
    expect(inv.number).toBe("CC/2026-27/00001");
    expect(inv.status).toBe("PAID");
    const ledger = await prisma.ledgerEntry.findMany({ where: { billId: r.billId! } });
    expect(ledger.map((l) => [l.source, l.method, l.amount])).toEqual([["MEMBERSHIP", "UPI", 200000]]);
    await expectIntegrity();
  });

  it("MB-3: an unpaid membership is PENDING_PAYMENT and the member is still priced as a walk-in", async () => {
    const r = await makeMember(w, { name: "Unpaid Uma", plan: "GOLD", pay: false });
    expect(r.membershipStatus).toBe("PENDING_PAYMENT");
    expect((await courtFee(r.memberId, "2026-10-12")).tier).toBe("WALK_IN");
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: r.billId!, method: "CARD", amount: 350000 });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: r.membershipId! } });
    expect(ms.status).toBe("ACTIVE");
    expect((await courtFee(r.memberId, "2026-10-12")).netAmount).toBe(0);
  });

  it("duplicate phone is rejected with a clear message", async () => {
    await createMember(w.actors.FRONT_DESK, { name: "Asha A", phone: "9811111111", dob: "1990-01-01" });
    await expect(createMember(w.actors.FRONT_DESK, { name: "Bela B", phone: "+91 98111 11111", dob: "1990-01-01" })).rejects.toThrow(/already registered with phone 9811111111/);
  });
});

describe("Phase 2 — Junior age rule (MB-2, MB-12)", () => {
  it("MB-2: Junior for an 18-year-old → JUNIOR_AGE_INELIGIBLE", async () => {
    await expect(makeMember(w, { name: "Adult Aditi", dob: "2008-10-12", plan: "JUNIOR" })).rejects.toMatchObject({ code: "JUNIOR_AGE_INELIGIBLE" });
  });

  it("MB-2: Junior for a 15-year-old is allowed", async () => {
    const r = await makeMember(w, { name: "Aarav", dob: "2011-03-01", plan: "JUNIOR" });
    expect(r.membershipStatus).toBe("ACTIVE");
    expect((await courtFee(r.memberId, "2026-10-12")).netAmount).toBe(10000);
  });

  it("MB-12: a Junior who turns 18 mid-membership keeps Junior, but renewal as Junior is blocked", async () => {
    const r = await makeMember(w, { name: "Turning Tara", dob: "2008-10-20", plan: "JUNIOR", months: 1 });
    clock.set(istToUtc("2026-10-25", "10:00"));
    expect((await effectiveStatus(r.memberId)).tier).toBe("JUNIOR");
    await expect(renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, months: 1 })).rejects.toMatchObject({ code: "JUNIOR_AGE_INELIGIBLE" });
    const ok = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 });
    expect(ok.startDate).toBe("2026-11-12");
  });
});

describe("Phase 2 — renew, upgrade, downgrade (MB-6, MB-7, MB-8, MB-9)", () => {
  it("MB-6: renewal of an active membership starts the day after it ends (SCHEDULED)", async () => {
    const r = await makeMember(w, { name: "Neha", plan: "SILVER", months: 1 });
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, months: 3 });
    expect(ren.startDate).toBe("2026-11-12");
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: ren.billId, method: "CASH", amount: ren.total });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: ren.membershipId } });
    expect(ms.status).toBe("SCHEDULED");
    await expect(renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, months: 1 })).rejects.toMatchObject({ code: "MEMBERSHIP_CONFLICT" });
  });

  it("MB-6: renewal of an expired membership starts today", async () => {
    const r = await makeMember(w, { name: "Lapsed Lata", plan: "SILVER", months: 1 });
    clock.set(istToUtc("2026-12-01", "10:00"));
    await runMembershipJob();
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, months: 1 });
    expect(ren.startDate).toBe("2026-12-01");
  });

  it("MB-7: upgrade credit maths and immediate effect; the old membership becomes CHANGED", async () => {
    clock.set(istToUtc("2026-10-01", "09:00"));
    const r = await makeMember(w, { name: "Upgrader Uday", plan: "SILVER", months: 1 });
    clock.set(T0); // 12 Oct
    const c = upgradeCredit(200000, "2026-10-01", "2026-10-31", "2026-10-12");
    expect(c).toEqual({ credit: 129032, remaining: 20, total: 31 });
    const up = await upgradeMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "GOLD", months: 1 });
    expect(up.credit).toBe(129032);
    expect(up.total).toBe(350000 - 129032);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: up.billId, method: "CARD", amount: up.total });
    const old = await prisma.membership.findUniqueOrThrow({ where: { id: r.membershipId! } });
    expect(old.status).toBe("CHANGED");
    expect(old.endDate.toISOString().slice(0, 10)).toBe("2026-10-11");
    expect((await effectiveStatus(r.memberId)).tier).toBe("GOLD");
    await expectIntegrity();
  });

  it("MB-7: a same-day upgrade works (old membership ends start − 1, status CHANGED)", async () => {
    const r = await makeMember(w, { name: "Same Day Sam", plan: "SILVER", months: 1 });
    const up = await upgradeMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "GOLD", months: 1 });
    expect(up.credit).toBe(200000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: up.billId, method: "CASH", amount: up.total });
    expect((await effectiveStatus(r.memberId)).tier).toBe("GOLD");
  });

  it("MB-7: a 'downgrade' via upgrade is rejected; MB-8 schedules it for the next renewal", async () => {
    const r = await makeMember(w, { name: "Down Dev", plan: "GOLD", months: 1 });
    await expect(upgradeMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 })).rejects.toMatchObject({ code: "MEMBERSHIP_CONFLICT" });
    await scheduleDowngrade(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 });
    expect((await effectiveStatus(r.memberId)).tier).toBe("GOLD");
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, months: 1 });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: ren.membershipId }, include: { plan: true } });
    expect(ms.plan.code).toBe("SILVER");
    expect(ren.total).toBe(200000);
  });

  it("members can renew/upgrade their own membership but not someone else's (§3)", async () => {
    const a = await makeMember(w, { name: "Own Olu", plan: "SILVER" });
    const b = await makeMember(w, { name: "Other Omar", plan: "SILVER" });
    await expect(renewMembership(a.actor, { memberId: b.memberId, months: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await upgradeMembership(a.actor, { memberId: a.memberId, planCode: "GOLD", months: 1 });
    expect(ok.status).toBe("PENDING_PAYMENT");
  });
});

describe("Phase 2 — expiry and reminders (MB-4, MB-10, MB-11)", () => {
  it("PR-3/MB-10: a member whose membership expires before the session date is priced as a walk-in", async () => {
    const r = await makeMember(w, { name: "Short Sid", plan: "SILVER", months: 1 }); // ends 2026-11-11
    expect((await courtFee(r.memberId, "2026-11-11")).netAmount).toBe(15000);
    const after = await courtFee(r.memberId, "2026-11-12");
    expect(after.tier).toBe("WALK_IN");
    expect(after.netAmount).toBe(40000);
  });

  it("MB-11: reminders fire 7 days before, 1 day before and the day after — each exactly once", async () => {
    const r = await makeMember(w, { name: "Remind Ria", plan: "SILVER", months: 1, email: "ria@example.com" }); // ends 2026-11-11
    clock.set(istToUtc("2026-11-04", "00:05"));
    expect((await runMembershipJob()).remindersSent).toBe(1);
    expect((await runMembershipJob()).remindersSent).toBe(0);
    clock.set(istToUtc("2026-11-10", "00:05"));
    expect((await runMembershipJob()).remindersSent).toBe(1);
    clock.set(istToUtc("2026-11-12", "00:05"));
    const j = await runMembershipJob();
    expect(j.expired).toBe(1);
    expect(j.remindersSent).toBe(1);
    expect((await runMembershipJob()).remindersSent).toBe(0);
    const kinds = await prisma.membershipReminder.findMany({ where: { membershipId: r.membershipId! } });
    expect(kinds.map((k) => k.reminderType).sort()).toEqual(["D1", "D7", "EXPIRED"]);
    const memberNotes = await prisma.notification.count({ where: { userId: r.member.userId! } });
    expect(memberNotes).toBeGreaterThanOrEqual(3);
    expect(await prisma.emailOutbox.count({ where: { to: "ria@example.com" } })).toBeGreaterThanOrEqual(3);
    const st = await effectiveStatus(r.memberId);
    expect(st.status).toBe("EXPIRED");
    expect(st.badge).toBe("red");
  });

  it("MB-5: the database allows at most one ACTIVE membership per member", async () => {
    const r = await makeMember(w, { name: "Uniq Uma", plan: "SILVER" });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: r.membershipId! } });
    await expect(
      prisma.membership.create({ data: { memberId: r.memberId, planId: ms.planId, startDate: ms.startDate, endDate: ms.endDate, durationMonths: 1, status: "ACTIVE", price: 0 } }),
    ).rejects.toThrow();
  });
});

describe("Phase 2 — cancellation, card, Member 360 (MB-13, MB-14, R-05, R-06)", () => {
  it("MB-13: only OWNER/MANAGER cancel, with a reason; optional refund is a negative ledger entry", async () => {
    const r = await makeMember(w, { name: "Cancel Cara", plan: "SILVER" });
    await expect(cancelMembership(w.actors.FRONT_DESK, { membershipId: r.membershipId!, reason: "moving" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await cancelMembership(w.actors.MANAGER, { membershipId: r.membershipId!, reason: "moving city", refundAmount: 100000, refundMethod: "UPI" });
    const ms = await prisma.membership.findUniqueOrThrow({ where: { id: r.membershipId! } });
    expect(ms.status).toBe("CANCELLED");
    const sum = await prisma.ledgerEntry.aggregate({ where: { billId: r.billId! }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(100000);
    expect((await effectiveStatus(r.memberId)).tier).toBe("WALK_IN");
    await expectIntegrity();
  });

  it("MB-14: a tampered member card QR → INVALID_MEMBER_CARD; a genuine one resolves", async () => {
    const r = await makeMember(w, { name: "Card Carl", plan: "GOLD" });
    const card = await memberCard(w.actors.FRONT_DESK, r.memberId);
    expect(card.qr).toMatch(/^data:image\/png;base64,/);
    expect((await lookupByCard(w.actors.FRONT_DESK, card.payload)).memberId).toBe(r.memberId);
    await expect(lookupByCard(w.actors.FRONT_DESK, card.payload.slice(0, -2) + "xx")).rejects.toMatchObject({ code: "INVALID_MEMBER_CARD" });
  });

  it("R-05/R-06: search by name/phone/code and the Member 360 shows status, memberships and payments", async () => {
    const r = await makeMember(w, { name: "Rahul Mehta", plan: "GOLD", months: 12 });
    expect((await searchMembers(w.actors.FRONT_DESK, "rahul")).map((m) => m.id)).toContain(r.memberId);
    expect((await searchMembers(w.actors.FRONT_DESK, r.memberCode)).map((m) => m.id)).toContain(r.memberId);
    expect((await searchMembers(w.actors.FRONT_DESK, r.member.phone.slice(-6))).map((m) => m.id)).toContain(r.memberId);
    const p = await member360(w.actors.FRONT_DESK, r.memberId);
    expect(p.status.tier).toBe("GOLD");
    expect(p.memberships).toHaveLength(1);
    expect(p.payments).toHaveLength(1);
    expect(p.totals.membershipSpend).toBe(3500000);
    await expect(member360(w.actors.BAR_STAFF, r.memberId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
