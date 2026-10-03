import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createSocialSession, joinSession } from "@/server/services/social";
import { createTrialBooking } from "@/server/services/crm";
import { isDomainError } from "@/server/errors";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

function tally(results: PromiseSettledResult<unknown>[]) {
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const codes = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (isDomainError(r.reason) ? r.reason.code : `UNEXPECTED: ${String(r.reason)}`));
  return { ok, codes };
}

describe("§10.2 concurrency", () => {
  it("20 parallel createBooking calls for the same court and time → exactly 1 success, 19 SLOT_TAKEN", async () => {
    const members = [];
    for (let i = 0; i < 20; i++) members.push(await makeMember(w, { name: `Racer ${i}`, plan: "SILVER" }));
    const results = await Promise.allSettled(members.map((m) => book(w, { time: "18:00", players: [{ memberId: m.memberId }] })));
    const t = tally(results);
    expect(t.ok).toBe(1);
    expect(t.codes).toEqual(Array(19).fill("SLOT_TAKEN"));
    expect(await prisma.courtReservation.count({ where: { status: "ACTIVE" } })).toBe(1);
    await expectIntegrity();
  });

  it("a member with 1 play: 2 parallel bookings on different courts → exactly 1 success, 1 DAILY_LIMIT_REACHED", async () => {
    const m = await makeMember(w, { name: "Greedy Gita", plan: "GOLD" });
    await book(w, { court: "Net A", time: "11:00", players: [{ memberId: m.memberId }] });
    const results = await Promise.allSettled([
      book(w, { court: "Court 1", time: "18:00", players: [{ memberId: m.memberId }] }),
      book(w, { court: "Court 2", time: "20:00", players: [{ memberId: m.memberId }] }),
    ]);
    const t = tally(results);
    expect(t.ok).toBe(1);
    expect(t.codes).toEqual(["DAILY_LIMIT_REACHED"]);
    await expectIntegrity();
  });

  it("social session with 1 spot left: 5 parallel joins → exactly 1 success", async () => {
    const ses = await createSocialSession(w.actors.MANAGER, { title: "Last Spot", courtIds: [w.courts["Court 4"].id], date: "2026-10-12", startTime: "19:00", endTime: "21:00", capacityPerCourt: 3 });
    const sessionId = ses.sessions[0].id;
    await joinSession(w.actors.FRONT_DESK, { sessionId, player: { guest: { name: "Early One" } } });
    await joinSession(w.actors.FRONT_DESK, { sessionId, player: { guest: { name: "Early Two" } } });
    const members = [];
    for (let i = 0; i < 5; i++) members.push(await makeMember(w, { name: `Joiner ${i}`, plan: "SILVER" }));
    const results = await Promise.allSettled(members.map((m) => joinSession(w.actors.FRONT_DESK, { sessionId, player: { memberId: m.memberId } })));
    const t = tally(results);
    expect(t.ok).toBe(1);
    expect(t.codes).toEqual(Array(4).fill("SESSION_FULL"));
    expect(await prisma.socialParticipant.count({ where: { sessionId, status: "JOINED" } })).toBe(3);
  });

  it("CR-8: 5 simultaneous trial requests from one new phone on different courts → exactly 1 trial, 4 TRIAL_ALREADY_USED", async () => {
    const courts = ["Court 1", "Court 2", "Court 3", "Court 4", "Net A"];
    const results = await Promise.allSettled(
      courts.map((c) => createTrialBooking({ consent: true, name: "Eager Ekta", phone: "9876500999", courtId: w.courts[c].id, date: "2026-10-12", startTime: "16:00" })),
    );
    const t = tally(results);
    expect(t.ok).toBe(1);
    expect(t.codes).toEqual(Array(4).fill("TRIAL_ALREADY_USED"));
    expect(await prisma.guest.count({ where: { phone: "9876500999" } })).toBe(1);
  });
});
