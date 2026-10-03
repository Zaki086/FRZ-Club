// Completion pass phase 3: account features for every role (§6) and the per-role checklists (§7).
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { actorFromToken, login, redeemPasswordSetToken, ROLE_HOME } from "@/server/auth/sessions";
import { changePassword, createResetLink, createResetLinkForMember, forgotPassword, getProfile, logoutEverywhere, updateProfile } from "@/server/auth/account";
import { rateLimit, resetRateLimits } from "@/server/rate-limit";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { addLines, openTab, settleTab, transferLine } from "@/server/services/bar";
import { deskToday } from "@/server/services/desk";
import { listStaffActivity } from "@/server/services/audit";
import { readUpload, saveUpload } from "@/server/services/uploads";
import { createExpense, setExpenseAttachment } from "@/server/services/expenses";
import { createEnquiry, createTrialBooking } from "@/server/services/crm";
import { updateSetting } from "@/server/services/settings";
import { SYSTEM, PUBLIC } from "@/server/rbac/actor";
import { makeWorld, TEST_PASSWORD, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeBar } from "../helpers/bar";
import { book, guest } from "../helpers/booking";

let w: World;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeEach(async () => {
  w = await makeWorld();
  resetRateLimits();
});

describe("Completion §6 — logging in", () => {
  it("5 wrong passwords lock the account (RATE_LIMITED) even for the right password; success records last login", async () => {
    for (let i = 0; i < 4; i++) await expect(login("9000000003", "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const ok = await login("9000000003", TEST_PASSWORD); // a success before the 5th resets the counter
    expect(ok.home).toBe(ROLE_HOME.FRONT_DESK);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.actors.FRONT_DESK.userId } })).lastLoginAt).not.toBeNull();
    for (let i = 0; i < 5; i++) await expect(login("9000000003", "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(login("9000000003", TEST_PASSWORD)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.actors.FRONT_DESK.userId } })).lockedUntil).not.toBeNull();
  });

  it("each role lands on its own home page", async () => {
    expect((await login("9000000007", TEST_PASSWORD)).home).toBe("/app/bar/kds");
    expect((await login("9000000006", TEST_PASSWORD)).home).toBe("/app/finance/cash");
    expect((await login("9000000004", TEST_PASSWORD)).home).toBe("/app/shop");
  });

  it("the in-house limiter allows N hits per window, then RATE_LIMITED", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 60_000);
    expect(() => rateLimit("k", 3, 60_000)).toThrow(/Too many/);
  });
});

describe("Completion §6 — passwords, devices, profile", () => {
  it("changing the password needs the current one and logs out the other devices only", async () => {
    const a = await login("9000000002", TEST_PASSWORD);
    const b = await login("9000000002", TEST_PASSWORD);
    await expect(changePassword(w.actors.MANAGER, a.token, { current: "nope-nope", next: "brand-new-pass" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await changePassword(w.actors.MANAGER, a.token, { current: TEST_PASSWORD, next: "brand-new-pass" });
    expect(await actorFromToken(a.token)).not.toBeNull();
    expect(await actorFromToken(b.token)).toBeNull();
    await expect(login("9000000002", TEST_PASSWORD)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await login("9000000002", "brand-new-pass")).user.role).toBe("MANAGER");
    await logoutEverywhere(w.actors.MANAGER);
    expect(await actorFromToken(a.token)).toBeNull();
  });

  it("forgot password: without email the club issues the link; with email a 1-hour link is mailed and logs out everywhere", async () => {
    setCapabilityOverridesForTests({ email: false });
    expect(await forgotPassword({ identifier: "9000000003" })).toMatchObject({ emailed: false });
    expect(await prisma.passwordSetToken.count({ where: { purpose: "RESET" } })).toBe(0);
    setCapabilityOverridesForTests({ email: true });
    await prisma.user.update({ where: { id: w.actors.FRONT_DESK.userId }, data: { email: "farah@example.com" } });
    const s = await login("9000000003", TEST_PASSWORD);
    expect(await forgotPassword({ identifier: "farah@example.com" })).toMatchObject({ emailed: true });
    expect(await forgotPassword({ identifier: "nobody@example.com" })).toMatchObject({ emailed: true }); // never reveals accounts
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { to: "farah@example.com" } });
    const token = /set-password\/([\w-]+)/.exec(mail.body)![1];
    await redeemPasswordSetToken(token, "after-reset-1");
    expect(await actorFromToken(s.token)).toBeNull();
    expect((await login("9000000003", "after-reset-1")).user.role).toBe("FRONT_DESK");
    await expect(redeemPasswordSetToken(token, "again-again")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("staff-issued reset links follow the hierarchy", async () => {
    const m = await makeMember(w, { name: "Link Lena", plan: "SILVER" });
    expect((await createResetLinkForMember(w.actors.FRONT_DESK, m.memberId)).link).toMatch(/^\/set-password\//);
    await expect(createResetLink(w.actors.FRONT_DESK, w.actors.BAR_STAFF.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await createResetLink(w.actors.MANAGER, w.actors.BAR_STAFF.userId)).expiresInMinutes).toBe(60);
    await expect(createResetLink(w.actors.MANAGER, w.actors.OWNER.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createResetLink(w.actors.BAR_STAFF, m.member.userId!)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await createResetLink(w.actors.OWNER, w.actors.MANAGER.userId)).name).toBe("Manish Manager");
  });

  it("profile: members edit email and emergency contact; an email used by someone else is refused", async () => {
    const m = await makeMember(w, { name: "Profile Pia", plan: "GOLD", email: "pia@example.com" });
    await makeMember(w, { name: "Other Ola", plan: "GOLD", email: "ola@example.com" });
    await expect(updateProfile(m.actor, { email: "ola@example.com" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const p = await updateProfile(m.actor, { email: "pia.new@example.com", emergencyContactName: "Mum", emergencyContactPhone: "98989 89898" });
    expect([p.email, p.member?.emergencyContactPhone]).toEqual(["pia.new@example.com", "9898989898"]);
    expect((await getProfile(w.actors.KITCHEN)).role).toBe("KITCHEN");
  });
});

describe("Completion §7 — per-role features", () => {
  it("bar: an item moves to another open tab and is re-priced for the new payer; not to a Junior if alcoholic", async () => {
    const bar = await makeBar(w);
    const silver = await makeMember(w, { name: "Silver Sid", plan: "SILVER" });
    const junior = await makeMember(w, { name: "Junior Jo", plan: "JUNIOR", dob: "2012-01-01" });
    const a = await openTab(w.actors.BAR_STAFF, { memberId: silver.memberId });
    const b = await openTab(w.actors.BAR_STAFF, { guest: { name: "Guest Gita" }, guestIdVerified: true });
    const j = await openTab(w.actors.BAR_STAFF, { memberId: junior.memberId });
    const added = await addLines(w.actors.BAR_STAFF, a.tabId, { items: [{ menuItemId: bar.fries.id, qty: 1 }, { menuItemId: bar.beer.id, qty: 1 }] });
    const [fries, beer] = added.lines;
    expect(fries.netAmount).toBe(16200); // Silver 10% off ₹180
    const moved = await transferLine(w.actors.BAR_STAFF, fries.id, b.tabId);
    expect(moved.to.total).toBe(18000); // the guest pays full price
    expect(moved.from.total).toBe(31500);
    await expect(transferLine(w.actors.BAR_STAFF, beer.id, j.tabId)).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    await settleTab(w.actors.BAR_STAFF, b.tabId, { payments: [{ method: "CASH", amount: 10000 }] });
    await expect(transferLine(w.actors.BAR_STAFF, moved.lineId, a.tabId)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
  });

  it("desk: Today shows who is arriving and what is still to collect", async () => {
    await book(w, { time: "11:00", players: [guest("Arriving Ari")] });
    const t = await deskToday(w.actors.FRONT_DESK);
    expect(t.arriving.map((x) => x.players[0])).toContain("Arriving Ari");
    expect(t.dues.total).toBe(40000);
    expect(t.drawer).not.toBeNull();
    await expect(deskToday(w.actors.BAR_STAFF)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("manager: staff activity by day, without the Owner's actions", async () => {
    await book(w, { time: "12:00", players: [guest("Logged Lia")] });
    await updateSetting(w.actors.OWNER, "max_plays_per_day", 2);
    const mine = await listStaffActivity(w.actors.MANAGER, { date: "2026-10-12" });
    expect(mine.rows.some((r) => r.action === "booking.create" && r.who === "Farah Desk")).toBe(true);
    expect(mine.rows.some((r) => r.action === "settings.update")).toBe(false);
    expect((await listStaffActivity(w.actors.OWNER, { date: "2026-10-12" })).rows.some((r) => r.action === "settings.update")).toBe(true);
    await expect(listStaffActivity(w.actors.FRONT_DESK, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accountant: a bill photo is checked (type by content, ≤ 2 MB), attached, and private to finance", async () => {
    await expect(saveUpload(w.actors.ACCOUNTANT, "expense", Buffer.from("not really a pdf"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(saveUpload(w.actors.ACCOUNTANT, "expense", Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(saveUpload(w.actors.BAR_STAFF, "expense", PNG)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const up = await saveUpload(w.actors.ACCOUNTANT, "expense", PNG);
    const e = await createExpense(w.actors.ACCOUNTANT, { vendor: "Paper Co", category: "OTHER", amount: 50000 });
    expect((await setExpenseAttachment(w.actors.ACCOUNTANT, e.id, up.url)).attachmentUrl).toBe(up.url);
    const [, , , kind, name] = up.url.split("/");
    expect((await readUpload(w.actors.MANAGER, kind, name)).type).toBe("image/png");
    await expect(readUpload(w.actors.BAR_STAFF, kind, name)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readUpload(PUBLIC, kind, "../../etc/passwd")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const prod = await saveUpload(w.actors.SHOP_STAFF, "product", PNG);
    expect((await readUpload(PUBLIC, "product", prod.url.split("/").pop()!)).type).toBe("image/png");
  });

  it("public forms need the consent tick (stored on the lead) and an empty honeypot", async () => {
    await expect(createEnquiry({ name: "No Tick", phone: "9876511111" } as never)).rejects.toThrow(/agree to be contacted/);
    await expect(createEnquiry({ consent: true, website: "http://spam", name: "Bot", phone: "9876511112" })).rejects.toThrow(/leave the last field empty/);
    const r = await createEnquiry({ consent: true, name: "Real Rhea", phone: "9876511113" });
    expect((await prisma.lead.findFirstOrThrow({ where: { code: r.leadCode } })).consentAt).not.toBeNull();
    await expect(createTrialBooking({ name: "No Tick", phone: "9876511114", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "15:00" } as never)).rejects.toThrow(/agree to be contacted/);
    void SYSTEM;
  });

  it("members add a partner by mobile number as well as by member code", async () => {
    const a = await makeMember(w, { name: "Booker Bea", plan: "GOLD" });
    const b = await makeMember(w, { name: "Partner Pat", plan: "SILVER" });
    const r = await book(w, { time: "17:00", players: [{ memberId: a.memberId }, { memberPhone: `+91 ${b.member.phone}` }], actor: a.actor, channel: "ONLINE_MEMBER" });
    const players = await prisma.bookingPlayer.findMany({ where: { bookingId: r.bookingId } });
    expect(players.map((p) => p.memberId).sort()).toEqual([a.memberId, b.memberId].sort());
    await expect(book(w, { time: "18:00", players: [{ memberId: a.memberId }, { memberPhone: "9999999999" }], actor: a.actor, channel: "ONLINE_MEMBER" })).rejects.toMatchObject({ code: "PLAYERS_INVALID" });
  });
});
