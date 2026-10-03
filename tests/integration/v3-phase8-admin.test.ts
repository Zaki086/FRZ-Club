// v3 phase 8 (admin group): the FilterBar lists for shifts, leave, audit log, staff users, data requests and the
// message log (§3.2) — each runs, a facet narrows with the right count, the summary strip adds up, and roles that
// could not see the old page are refused.
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istDayRange, istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { listView } from "@/server/services/filters";
import { logMessage } from "@/server/services/messages";
import { assignShift, decideLeave, expireStaleLeave, removeShift, requestLeave } from "@/server/services/staff";
import { setUserActive } from "@/server/services/users";
import { makeWorld, T0, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";

let w: World;
type Facets = Array<{ key: string; options: Array<{ value: string; count: number }> }>;
const count = (facets: Facets, key: string, value: string) => facets.find((f) => f.key === key)?.options.find((o) => o.value === value)?.count ?? 0;
const sum = (r: { summary: Array<{ key: string; value: number }> }, key: string) => r.summary.find((s) => s.key === key)!.value;

beforeEach(async () => {
  w = await makeWorld();
});

describe("v3 phase 8 — admin lists", () => {
  it("shifts: upcoming by default, area / status / employee facets, open shifts and hours in the strip", async () => {
    const shift = (role: "FRONT_DESK" | "BAR_STAFF" | "SHOP_STAFF", date: string, startTime: string, endTime: string, area: "FRONT_DESK" | "BAR" | "SHOP") =>
      assignShift(w.actors.MANAGER, { employeeId: w.actors[role].employeeId!, date, startTime, endTime, area });
    await shift("FRONT_DESK", "2026-10-12", "10:00", "18:00", "FRONT_DESK");
    await shift("BAR_STAFF", "2026-10-13", "12:00", "16:00", "BAR");
    const shop = await shift("SHOP_STAFF", "2026-10-14", "09:00", "13:00", "SHOP");
    await removeShift(w.actors.MANAGER, shop.id); // stays on the roster as OPEN

    const r = await listView(w.actors.MANAGER, "shifts", {});
    expect(r.query.when).toBe("upcoming");
    expect(r.total).toBe(3);
    expect([sum(r, "open"), sum(r, "today"), sum(r, "hours")]).toEqual([1, 1, 480 + 240]);
    expect([count(r.facets, "area", "BAR"), count(r.facets, "status", "OPEN"), count(r.facets, "employee", "open")]).toEqual([1, 1, 1]);

    const bar = await listView(w.actors.MANAGER, "shifts", { area: "BAR" });
    expect(bar.rows.map((x) => [x.name, x.day, x.minutes])).toEqual([["Bina Bar", "2026-10-13", 240]]);
    const open = await listView(w.actors.MANAGER, "shifts", { employee: "open" });
    expect(open.rows.map((x) => [x.status, x.previous_name])).toEqual([["OPEN", "Sameer Shop"]]);
    const tomorrow = await listView(w.actors.MANAGER, "shifts", { range: "CUSTOM", from: "2026-10-13", to: "2026-10-13" });
    expect(tomorrow.total).toBe(1);

    await expect(listView(w.actors.FRONT_DESK, "shifts", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.ACCOUNTANT, "shifts", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leave: opens on pending; type / status facets; pending, days approved this month and expired in the strip", async () => {
    await assignShift(w.actors.MANAGER, { employeeId: w.actors.FRONT_DESK.employeeId!, date: "2026-10-20", startTime: "10:00", endTime: "18:00", area: "FRONT_DESK" });
    await requestLeave(w.actors.FRONT_DESK, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-21", reason: "family function" });
    const sick = await requestLeave(w.actors.BAR_STAFF, { type: "SICK", startDate: "2026-10-15", endDate: "2026-10-16", reason: "dentist" });
    await decideLeave(w.actors.MANAGER, sick.id, "APPROVED");
    await requestLeave(w.actors.SHOP_STAFF, { type: "CASUAL", startDate: "2026-10-13", endDate: "2026-10-13", reason: "errand" });
    clock.set(istToUtc("2026-10-14", "10:00"));
    expect((await expireStaleLeave()).expired).toBe(1);

    const r = await listView(w.actors.MANAGER, "leave", {});
    expect(r.query.status).toBe("PENDING");
    expect(r.rows.map((x) => [x.name, x.type, x.days, x.shifts_affected])).toEqual([["Farah Desk", "CASUAL", 2, 1]]);
    // The strip is club-wide: approved and expired show even though the list opens on pending.
    expect([sum(r, "pending"), sum(r, "approved"), sum(r, "expired")]).toEqual([1, 2, 1]);

    const all = await listView(w.actors.MANAGER, "leave", { status: "PENDING,APPROVED,EXPIRED" });
    expect(all.total).toBe(3);
    expect([count(all.facets, "type", "CASUAL"), count(all.facets, "type", "SICK"), count(all.facets, "status", "EXPIRED")]).toEqual([2, 1, 1]);
    const casual = await listView(w.actors.MANAGER, "leave", { status: "PENDING,APPROVED,EXPIRED", type: "CASUAL" });
    expect(casual.rows.map((x) => x.name).sort()).toEqual(["Farah Desk", "Sameer Shop"]);
    const approved = await listView(w.actors.OWNER, "leave", { status: "APPROVED", month: "this" });
    expect(approved.rows.map((x) => [x.name, x.status, x.decided_by_name])).toEqual([["Bina Bar", "APPROVED", "Manish Manager"]]);

    await expect(listView(w.actors.FRONT_DESK, "leave", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.ACCOUNTANT, "leave", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("audit: Owner only, last 7 days by default, action / actor facets, entries with a reason in the strip", async () => {
    const mgr = w.actors.MANAGER;
    const base = { actorId: mgr.userId, actorLabel: `${mgr.name} (MANAGER)`, action: "phase8.poke", entity: "shift", entityId: "shift-p8" };
    await prisma.auditLog.create({ data: { ...base, reason: "checking the list", at: T0 } });
    await prisma.auditLog.create({ data: { ...base, at: new Date(T0.getTime() - 10 * 86_400_000) } });

    const r = await listView(w.actors.OWNER, "audit", {});
    expect(r.query.range).toBe("LAST_7");
    const [from] = istDayRange("2026-10-06");
    const [, to] = istDayRange("2026-10-12");
    expect(r.total).toBe(await prisma.auditLog.count({ where: { at: { gte: from, lt: to } } }));

    const recent = await listView(w.actors.OWNER, "audit", { action: "phase8.poke", range: "LAST_7" });
    expect(recent.rows.map((x) => [x.entity_id, x.reason])).toEqual([["shift-p8", "checking the list"]]);
    expect(sum(recent, "reason")).toBe(1);
    const ever = await listView(w.actors.OWNER, "audit", { action: "phase8.poke" });
    expect(ever.total).toBe(2);
    expect(count(ever.facets, "actor", mgr.userId)).toBe(2);
    const withReason = await listView(w.actors.OWNER, "audit", { action: "phase8.poke", reason: "yes" });
    expect(withReason.total).toBe(1);
    const system = await listView(w.actors.OWNER, "audit", { actor: "system", range: "LAST_7" });
    expect(system.total).toBe(await prisma.auditLog.count({ where: { actorId: null, actorLabel: { not: "public website" }, at: { gte: from, lt: to } } }));

    await expect(listView(w.actors.MANAGER, "audit", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("users: role / active / logged-in / locked facets and the strip; Owner only", async () => {
    await prisma.user.updateMany({ data: { lastLoginAt: null, lockedUntil: null } });
    await prisma.user.update({ where: { id: w.actors.FRONT_DESK.userId }, data: { lastLoginAt: T0 } });
    await prisma.user.update({ where: { id: w.actors.SHOP_STAFF.userId }, data: { lockedUntil: new Date(T0.getTime() + 3_600_000) } });
    await prisma.user.update({ where: { id: w.actors.KITCHEN.userId }, data: { lockedUntil: new Date(T0.getTime() - 3_600_000) } }); // lock has passed
    await setUserActive(w.actors.OWNER, w.actors.BAR_STAFF.userId, false);
    await makeMember(w, { name: "Not Staff" }); // members are never in this list

    const r = await listView(w.actors.OWNER, "users", {});
    expect(r.total).toBe(7);
    expect([sum(r, "active"), sum(r, "never"), sum(r, "locked"), sum(r, "inactive")]).toEqual([6, 5, 1, 1]);
    expect(r.rows.find((x) => x.name === "Farah Desk")).not.toHaveProperty("password_hash");

    const locked = await listView(w.actors.OWNER, "users", { locked: "yes" });
    expect(locked.rows.map((x) => x.name)).toEqual(["Sameer Shop"]);
    const loggedIn = await listView(w.actors.OWNER, "users", { login: "yes" });
    expect(loggedIn.rows.map((x) => x.name)).toEqual(["Farah Desk"]);
    const managers = await listView(w.actors.OWNER, "users", { role: "MANAGER" });
    expect(managers.rows.map((x) => x.name)).toEqual(["Manish Manager"]);
    expect(count(managers.facets, "role", "OWNER")).toBe(1); // counted with every other filter applied
    const inactive = await listView(w.actors.OWNER, "users", { active: "no" });
    expect(inactive.rows.map((x) => x.name)).toEqual(["Bina Bar"]);

    await expect(listView(w.actors.MANAGER, "users", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("data requests: opens on erasure requests; kind / status facets and the strip; Owner only", async () => {
    const { member } = await makeMember(w, { name: "Privacy Priya" });
    await prisma.dataRequest.create({ data: { memberId: member.id, kind: "ERASE", status: "OPEN", note: "please erase" } });
    await prisma.dataRequest.create({ data: { memberId: member.id, kind: "ERASE", status: "REJECTED", note: "dues pending" } });
    await prisma.dataRequest.create({ data: { memberId: member.id, kind: "EXPORT", status: "DONE", note: "Self-service download" } });

    const r = await listView(w.actors.OWNER, "data-requests", {});
    expect(r.query.kind).toBe("ERASE");
    expect(r.total).toBe(2);
    expect(r.rows[0]).toMatchObject({ status: "OPEN", member_name: "Privacy Priya", member_code: member.memberCode });
    expect([sum(r, "open"), sum(r, "done"), sum(r, "rejected")]).toEqual([1, 0, 1]);

    const both = await listView(w.actors.OWNER, "data-requests", { kind: "ERASE,EXPORT" });
    expect([count(both.facets, "status", "OPEN"), count(both.facets, "status", "DONE"), count(both.facets, "status", "REJECTED")]).toEqual([1, 1, 1]);
    const done = await listView(w.actors.OWNER, "data-requests", { status: "DONE" });
    expect(done.rows.map((x) => x.kind)).toEqual(["EXPORT"]);

    await expect(listView(w.actors.MANAGER, "data-requests", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("messages: last 7 days by default; channel / status facets and the strip; Owner only", async () => {
    clock.set(new Date(T0.getTime() - 10 * 86_400_000));
    await logMessage(prisma, { channel: "EMAIL", to: "old.phase8@test.club", subject: "Old", body: "an old email", status: "SENT" });
    clock.set(T0);
    await logMessage(prisma, { channel: "EMAIL", to: "a.phase8@test.club", subject: "Hello", body: "welcome", status: "SENT" });
    await logMessage(prisma, { channel: "EMAIL", to: "b.phase8@test.club", subject: "Receipt", body: "your receipt", status: "FAILED", error: "mailbox full" });
    await logMessage(prisma, { channel: "WHATSAPP", to: "919800000001", body: "phase8 booking confirmed", status: "OPENED" });

    expect((await listView(w.actors.OWNER, "messages", {})).query.range).toBe("LAST_7");
    const r = await listView(w.actors.OWNER, "messages", { q: "phase8", range: "LAST_7" });
    expect(r.total).toBe(3);
    expect([sum(r, "sent"), sum(r, "failed"), sum(r, "opened")]).toEqual([1, 1, 1]);
    expect([count(r.facets, "channel", "EMAIL"), count(r.facets, "channel", "WHATSAPP")]).toEqual([2, 1]);

    const emails = await listView(w.actors.OWNER, "messages", { q: "phase8", channel: "EMAIL" });
    expect(emails.total).toBe(3); // no date filter: the old one too
    const failed = await listView(w.actors.OWNER, "messages", { q: "phase8", status: "FAILED" });
    expect(failed.rows.map((x) => [x.recipient, x.error])).toEqual([["b.phase8@test.club", "mailbox full"]]);

    await expect(listView(w.actors.MANAGER, "messages", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
