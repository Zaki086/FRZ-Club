// v5 §3.3–3.4 (MSGUI): what the screens need from the server to put "Send message" and bulk selection on them.
// Check-in Risk rows name the member each problem is about (the composer's MEMBER record and the bulk list's id);
// a booking's unpaid bill names nobody (its "Send message" goes to the booking, from the arrival's key).
import { beforeEach, describe, expect, it } from "vitest";
import { dbDate } from "@/lib/time";
import { prisma } from "@/server/db";
import { checkinRisks } from "@/server/services/checkin-risk";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Monday 12 Oct 2026, 10:00 IST
});

describe("v5 §3.3 Check-in Risk — the message target of each row", () => {
  it("member problems carry the member's id; the booking's unpaid bill carries none (the message goes to the booking)", async () => {
    const exp = await makeMember(w, { name: "Expiring Esha", plan: "SILVER" });
    await prisma.membership.updateMany({ where: { memberId: exp.memberId }, data: { startDate: dbDate("2026-09-15"), endDate: dbDate("2026-10-15"), status: "ACTIVE" } });
    const owes = await makeMember(w, { name: "Owing Omar", plan: "GOLD", pay: false });
    const unpaid = await book(w, { time: "11:00", players: [{ memberId: exp.memberId }, guest("Guest Gopal")] });
    await book(w, { court: "Court 2", time: "18:00", players: [{ memberId: owes.memberId }], payment: { kind: "COUNTER", method: "CASH" } });

    const r = await checkinRisks(w.actors.FRONT_DESK);
    const risks = r.arrivals.flatMap((a) => a.risks.map((x) => ({ key: a.key, kind: x.kind, who: x.who, memberId: x.memberId })));
    expect(risks).toContainEqual({ key: `booking:${unpaid.bookingId}`, kind: "UNPAID", who: "Expiring Esha, Guest Gopal", memberId: null });
    expect(risks).toContainEqual({ key: `booking:${unpaid.bookingId}`, kind: "MEMBERSHIP_EXPIRING", who: "Expiring Esha", memberId: exp.memberId });
    expect(risks.find((x) => x.kind === "DUES")).toMatchObject({ who: "Owing Omar", memberId: owes.memberId });
  });
});
