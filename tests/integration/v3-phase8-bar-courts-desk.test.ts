// v3 phase 8 (§3.2): the FilterBar lists for the bar (tabs, bar days), social play (sessions, players) and the desk
// (check-ins) — server-side facets with counts, summary strip numbers and who may see each list.
import { describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { listView } from "@/server/services/filters";
import { addLines, carryTab, closeBarDay, openTab, settleTab } from "@/server/services/bar";
import { cancelSocialSession, createSocialSession, joinSession } from "@/server/services/social";
import { checkIn, checkOut } from "@/server/services/checkin";
import { makeWorld, T0 } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeBar } from "../helpers/bar";
import { book, guest } from "../helpers/booking";

type Facet = { key: string; options: Array<{ value: string; count: number }> };
const count = (facets: Facet[], key: string, value: string) => facets.find((f) => f.key === key)!.options.find((o) => o.value === value)?.count ?? 0;
const sum = (r: { summary: Array<{ key: string; value: number }> }, key: string) => r.summary.find((s) => s.key === key)!.value;

describe("v3 §3.2 — bar tabs list", () => {
  it("filters by status, table and payer; the strip shows open tabs, carried and settled-today money; front desk is refused", async () => {
    const w = await makeWorld();
    const bar = await makeBar(w);
    const kiran = await makeMember(w, { name: "Kiran Kumar", plan: "SILVER" });
    const t1 = await openTab(w.actors.BAR_STAFF, { memberId: kiran.memberId, tableId: bar.table4.id });
    const open = await addLines(w.actors.BAR_STAFF, t1.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }] });
    const t2 = await openTab(w.actors.BAR_STAFF, { guest: { name: "Guest Gopal" } });
    await addLines(w.actors.BAR_STAFF, t2.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }] });
    await settleTab(w.actors.BAR_STAFF, t2.tabId, { payments: [{ method: "CASH", amount: 12000 }] });
    const t3 = await openTab(w.actors.BAR_STAFF, { guest: { name: "Carry Cara" } });
    await addLines(w.actors.BAR_STAFF, t3.tabId, { items: [{ menuItemId: bar.fries.id, qty: 1 }] });
    await carryTab(w.actors.MANAGER, t3.tabId, "regular, pays tomorrow");

    let r = await listView(w.actors.BAR_STAFF, "tabs", {});
    expect(r.total).toBe(3);
    expect([count(r.facets, "status", "OPEN"), count(r.facets, "status", "SETTLED"), count(r.facets, "status", "CARRIED")]).toEqual([1, 1, 1]);
    expect(count(r.facets, "table", bar.table4.id)).toBe(1);
    expect(count(r.facets, "table", "counter")).toBe(2);
    expect(sum(r, "open")).toBe(1);
    expect(sum(r, "open_due")).toBe(open.total);
    expect(sum(r, "carried_due")).toBe(18000);
    expect(sum(r, "settled_today")).toBe(12000);
    expect(r.rows[0].code).toBe(t1.code); // open tabs first

    r = await listView(w.actors.BAR_STAFF, "tabs", { status: "OPEN" });
    expect(r.rows.map((x) => x.code)).toEqual([t1.code]);
    expect(count(r.facets, "status", "CARRIED")).toBe(1); // its own facet is not narrowed
    r = await listView(w.actors.BAR_STAFF, "tabs", { who: "guest" });
    expect(r.rows.map((x) => x.code).sort()).toEqual([t2.code, t3.code].sort());
    expect(sum(r, "open")).toBe(0);
    r = await listView(w.actors.MANAGER, "tabs", { table: bar.table4.id });
    expect(r.rows.map((x) => x.payer)).toEqual(["Kiran Kumar"]);

    await expect(listView(w.actors.FRONT_DESK, "tabs", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.ACCOUNTANT, "tabs", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v3 §3.2 — bar days list", () => {
  it("lists closed and open days with what they collected and the bar drawer variance; front desk is refused", async () => {
    const w = await makeWorld(istToUtc("2026-10-11", "10:00"));
    const bar = await makeBar(w);
    const a = await openTab(w.actors.BAR_STAFF, { guest: { name: "Sunday Sam" } });
    await addLines(w.actors.BAR_STAFF, a.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }] });
    await settleTab(w.actors.BAR_STAFF, a.tabId, { payments: [{ method: "CASH", amount: 12000 }] });
    await closeBarDay(w.actors.MANAGER, "2026-10-11");

    clock.set(T0); // Monday 12 Oct
    const b = await openTab(w.actors.BAR_STAFF, { guest: { name: "Monday Mo" } });
    await addLines(w.actors.BAR_STAFF, b.tabId, { items: [{ menuItemId: bar.fries.id, qty: 1 }] });
    await prisma.cashDrawerSession.create({
      data: { userId: w.actors.BAR_STAFF.userId, area: "BAR", openingFloat: 0, openedAt: istToUtc("2026-10-12", "08:00"), closedAt: istToUtc("2026-10-12", "09:00"), cashExpected: 1000, cashCounted: 500, variance: -500 },
    });

    let r = await listView(w.actors.BAR_STAFF, "bar-days", {});
    expect(r.rows.map((x) => x.id)).toEqual(["2026-10-12", "2026-10-11"]);
    expect([count(r.facets, "status", "OPEN"), count(r.facets, "status", "CLOSED")]).toEqual([1, 1]);
    const sunday = r.rows.find((x) => x.id === "2026-10-11")!;
    expect([sunday.status, sunday.collected, sunday.tabs_opened, sunday.tabs_settled]).toEqual(["CLOSED", 12000, 1, 1]);
    const monday = r.rows.find((x) => x.id === "2026-10-12")!;
    expect([monday.status, monday.blocking, monday.variance]).toEqual(["OPEN", 1, -500]);
    expect([sum(r, "open"), sum(r, "collected"), sum(r, "variance_days"), sum(r, "variance")]).toEqual([1, 12000, 1, -500]);

    r = await listView(w.actors.MANAGER, "bar-days", { variance: "yes" });
    expect(r.rows.map((x) => x.id)).toEqual(["2026-10-12"]);
    r = await listView(w.actors.MANAGER, "bar-days", { status: "CLOSED" });
    expect(r.rows.map((x) => x.id)).toEqual(["2026-10-11"]);
    expect(sum(r, "collected")).toBe(12000);

    await expect(listView(w.actors.FRONT_DESK, "bar-days", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v3 §3.2 — social play lists", () => {
  it("sessions: places, fees to collect and status; players: status, member/guest, payment; the bar is refused", async () => {
    const w = await makeWorld();
    const neha = await makeMember(w, { name: "Neha Nair", plan: "GOLD" });
    const s1 = await createSocialSession(w.actors.MANAGER, { title: "Monday Mixer", courtIds: [w.courts["Court 4"].id], date: "2026-10-12", startTime: "19:00", endTime: "21:00", capacityPerCourt: 4 });
    const s2 = await createSocialSession(w.actors.MANAGER, { title: "Tiny Social", courtIds: [w.courts["Court 3"].id], date: "2026-10-12", startTime: "19:00", endTime: "21:00", capacityPerCourt: 2 });
    const id1 = s1.sessions[0].id;
    const id2 = s2.sessions[0].id;
    await joinSession(w.actors.FRONT_DESK, { sessionId: id1, player: { memberId: neha.memberId }, payment: { kind: "COUNTER", method: "CASH" } });
    const ga = await joinSession(w.actors.FRONT_DESK, { sessionId: id1, player: guest("Guest Anu") });
    const gb = await joinSession(w.actors.FRONT_DESK, { sessionId: id2, player: guest("Guest Bala") });
    const gc = await joinSession(w.actors.FRONT_DESK, { sessionId: id2, player: guest("Guest Chitra") });
    expect(ga.due).toBeGreaterThan(0);

    let r = await listView(w.actors.FRONT_DESK, "social", {});
    expect(r.query.when).toBe("upcoming"); // the default view
    expect(r.total).toBe(2);
    expect([count(r.facets, "places", "yes"), count(r.facets, "places", "no")]).toEqual([1, 1]);
    expect([sum(r, "scheduled"), sum(r, "joined"), sum(r, "free"), sum(r, "due")]).toEqual([2, 4, 2, ga.due + gb.due + gc.due]);
    const mixer = r.rows.find((x) => x.id === id1)!;
    expect([mixer.capacity, mixer.joined, mixer.free, (mixer.participants as unknown[]).length]).toEqual([4, 2, 2, 2]);
    r = await listView(w.actors.FRONT_DESK, "social", { places: "yes" });
    expect(r.rows.map((x) => x.title)).toEqual(["Monday Mixer"]);
    r = await listView(w.actors.FRONT_DESK, "social", { court: w.courts["Court 3"].id });
    expect(r.rows.map((x) => x.title)).toEqual(["Tiny Social"]);

    await cancelSocialSession(w.actors.MANAGER, id2, "rain");
    r = await listView(w.actors.MANAGER, "social", {});
    expect([count(r.facets, "status", "SCHEDULED"), count(r.facets, "status", "CANCELLED")]).toEqual([1, 1]);
    expect(sum(r, "scheduled")).toBe(1);

    let p = await listView(w.actors.FRONT_DESK, "social-participants", {});
    expect(p.total).toBe(4);
    expect([count(p.facets, "status", "JOINED"), count(p.facets, "status", "LEFT")]).toEqual([2, 2]);
    expect([count(p.facets, "who", "member"), count(p.facets, "who", "guest")]).toEqual([1, 3]);
    expect([sum(p, "joined"), sum(p, "due"), sum(p, "checked_in"), sum(p, "by_club")]).toEqual([2, ga.due, 0, 0]);
    p = await listView(w.actors.FRONT_DESK, "social-participants", { payment: "UNPAID" });
    expect(p.rows.map((x) => x.name)).toEqual(["Guest Anu"]);
    p = await listView(w.actors.FRONT_DESK, "social-participants", { status: "LEFT", who: "guest" });
    expect(p.rows.map((x) => x.name).sort()).toEqual(["Guest Bala", "Guest Chitra"]);

    await expect(listView(w.actors.BAR_STAFF, "social", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.BAR_STAFF, "social-participants", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v3 §3.2 — check-ins list", () => {
  it("today by default; kind, tier, member/guest and who checked in; check-out narrows 'not checked out'; the bar is refused", async () => {
    const w = await makeWorld();
    const ravi = await makeMember(w, { name: "Ravi Rao", plan: "SILVER" });
    const b = await book(w, { time: "10:30", players: [{ memberId: ravi.memberId }, guest("Visitor Vik")], payment: { kind: "COUNTER", method: "CASH" } });
    for (const bp of await prisma.bookingPlayer.findMany({ where: { bookingId: b.bookingId } })) await checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id });
    await prisma.visit.create({ data: { memberId: ravi.memberId, checkedInAt: istToUtc("2026-10-11", "18:00"), checkedOutAt: istToUtc("2026-10-11", "20:00"), byUserId: w.actors.MANAGER.userId } });

    let r = await listView(w.actors.FRONT_DESK, "visits", {});
    expect(r.query.range).toBe("TODAY");
    expect(r.total).toBe(2);
    expect([sum(r, "total"), sum(r, "members"), sum(r, "guests"), sum(r, "in")]).toEqual([2, 1, 1, 1]);
    expect(count(r.facets, "kind", "BOOKING")).toBe(2);
    expect([count(r.facets, "tier", "SILVER"), count(r.facets, "tier", "GUEST")]).toEqual([1, 1]);
    expect(count(r.facets, "by", w.actors.FRONT_DESK.userId)).toBe(2);
    r = await listView(w.actors.FRONT_DESK, "visits", { range: "TODAY", who: "guest" });
    expect(r.rows.map((x) => x.name)).toEqual(["Visitor Vik"]);
    r = await listView(w.actors.FRONT_DESK, "visits", { range: "LAST_7" });
    expect(r.total).toBe(3);
    expect(count(r.facets, "by", w.actors.MANAGER.userId)).toBe(1);

    await checkOut(w.actors.FRONT_DESK, ravi.memberId);
    r = await listView(w.actors.FRONT_DESK, "visits", { range: "TODAY", state: "IN" });
    expect(r.rows.map((x) => x.name)).toEqual(["Visitor Vik"]);
    expect(sum(r, "in")).toBe(0);

    await expect(listView(w.actors.BAR_STAFF, "visits", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
