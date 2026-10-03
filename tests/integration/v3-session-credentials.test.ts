// Owner report (2026-10-03): "a member created at the front desk sets a password from the QR, logs in, and after a few
// minutes the session ends and the same password no longer works". The cause was the e2e gate resetting the live
// database; these tests pin the real flow so it stays right: the session lasts days, the password keeps working
// after later payments, and logging in again never invalidates the password or the other session.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { SESSION_POLICY, actorFromToken, login, logout, redeemPasswordSetToken } from "@/server/auth/sessions";
import { createMember, renewMembership } from "@/server/services/membership";
import { recordCounterPayment } from "@/server/services/payments";
import { makeWorld, utr, type World } from "../helpers/world";

const DAY_MS = 86_400_000;
let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

async function deskMemberWithPassword(password: string) {
  const r = await createMember(w.actors.FRONT_DESK, {
    name: "Desk Divya", phone: "9876598765", dob: "1994-04-04",
    plan: { code: "SILVER", months: 1, payment: { method: "UPI", reference: utr() } },
  });
  expect(r.setPasswordToken).toBeTruthy(); // the QR on the desk screen carries this link
  await redeemPasswordSetToken(r.setPasswordToken!, password);
  return r;
}

describe("sessions after a desk sign-up and the QR set-password link", () => {
  it("every session lasts at least 3 days without use (owner: 'expire after 2–3 days', never minutes)", () => {
    for (const p of Object.values(SESSION_POLICY)) {
      expect(p.idleDays).toBeGreaterThanOrEqual(3);
      expect(p.absoluteDays).toBeGreaterThanOrEqual(p.idleDays);
    }
  });

  it("the member logs in with the new password; the session is valid for days and slides with use", async () => {
    await deskMemberWithPassword("divya-own-pass");
    const s = await login("9876598765", "divya-own-pass");
    expect(s.user.role).toBe("MEMBER");
    expect(s.idleExpiresAt.getTime() - Date.now()).toBeGreaterThan(3 * DAY_MS - 60_000);
    expect((await actorFromToken(s.token))?.userId).toBe(s.user.id);
    // Two days later with little left of the idle window: still valid, and using the app extends it.
    const row = await prisma.session.findFirstOrThrow({ where: { userId: s.user.id } });
    await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 60 * 60_000), lastSeenAt: new Date(Date.now() - 2 * DAY_MS) } });
    expect((await actorFromToken(s.token))?.userId).toBe(s.user.id);
    const slid = await prisma.session.findUniqueOrThrow({ where: { id: row.id } });
    expect(slid.expiresAt.getTime() - Date.now()).toBeGreaterThan(3 * DAY_MS - 60_000);
  });

  it("the same password keeps working: log out and back in, a second device, and after a later desk payment", async () => {
    const r = await deskMemberWithPassword("divya-own-pass");
    const phone = await login("9876598765", "divya-own-pass");
    await logout(phone.token);
    expect(await actorFromToken(phone.token)).toBeNull();
    const again = await login("9876598765", "divya-own-pass");
    const laptop = await login("9876598765", "divya-own-pass");
    expect((await actorFromToken(again.token))?.userId).toBe(again.user.id); // a second login doesn't end the first
    // A renewal paid at the desk must not reissue credentials or touch the password.
    const ren = await renewMembership(w.actors.FRONT_DESK, { memberId: r.memberId, planCode: "SILVER", months: 1 });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: ren.billId, method: "UPI", amount: ren.total, reference: utr() });
    expect((await login("9876598765", "divya-own-pass")).user.id).toBe(again.user.id);
    expect((await actorFromToken(laptop.token))?.userId).toBe(again.user.id);
    // The used QR link can't be replayed to change the password behind the member's back.
    await expect(redeemPasswordSetToken(r.setPasswordToken!, "someone-else")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
