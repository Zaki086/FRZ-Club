import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  addLines, barDayReport, carryTab, closeBarDay, getTab, kitchenQueue, listTables, openTab, readyQueue, sendToKitchen, setLineStatus, settleTab, verifyGuestId, voidLine,
} from "@/server/services/bar";
import { clockIn, clockOut } from "@/server/services/staff";
import { makeWorld, type World, utr, CARD_PROOF } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeBar } from "../helpers/bar";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
let bar: Awaited<ReturnType<typeof makeBar>>;
beforeEach(async () => {
  w = await makeWorld();
  bar = await makeBar(w);
});

describe("Phase 5 — tabs and payer discounts (BR-3, BR-4, R-26, R-27)", () => {
  it("R-27/PR-6: a Silver member's tab gets 10% off automatically; Gold 15%; guests pay full price", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: kiran.memberId, tableId: bar.table4.id });
    const r = await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.lime.id, qty: 2 }, { menuItemId: bar.fries.id, qty: 1, note: "extra spicy" }] });
    expect(r.lines.map((l) => [l.discountPct, l.netAmount])).toEqual([[10, 21600], [10, 16200]]);
    expect(r.lines[0].explanation).toMatch(/Silver member · 10% bar discount/);
    const g = await openTab(w.actors.BAR_STAFF, { guest: { name: "Guest Gopal" } });
    expect((await addLines(w.actors.BAR_STAFF, g.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }] })).total).toBe(12000);
  });

  it("BR-3: a member can have only one OPEN tab", async () => {
    const m = await makeMember(w, { name: "One Tab", plan: "GOLD" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: m.memberId });
    await expect(openTab(w.actors.BAR_STAFF, { memberId: m.memberId })).rejects.toMatchObject({ code: "TAB_ALREADY_OPEN", message: expect.stringContaining(t.code) });
  });

  it("BR-2: a table is OCCUPIED while an open tab sits on it; several tabs can share a table", async () => {
    await openTab(w.actors.BAR_STAFF, { guest: { name: "A Guest" }, tableId: bar.table4.id });
    await openTab(w.actors.BAR_STAFF, { guest: { name: "B Guest" }, tableId: bar.table4.id });
    const t = await listTables(w.actors.BAR_STAFF);
    const t4 = t.tables.find((x) => x.number === 4)!;
    expect(t4.status).toBe("OCCUPIED");
    expect(t4.tabs).toHaveLength(2);
    expect(t.tables.find((x) => x.number === 1)!.status).toBe("FREE");
  });
});

describe("Phase 5 — alcohol (BR-5, E-12)", () => {
  it("E-12: a beer on a Junior's tab → ALCOHOL_NOT_ALLOWED; their discount still applies to soft drinks", async () => {
    const aarav = await makeMember(w, { name: "Aarav", plan: "JUNIOR", dob: "2011-03-01" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: aarav.memberId });
    await expect(addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }] })).rejects.toMatchObject({
      code: "ALCOHOL_NOT_ALLOWED",
      message: "Kingfisher pint can't be served: Aarav is a Junior member (age 15).",
    });
    const ok = await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }] });
    expect(ok.lines[0].discountPct).toBe(5);
  });

  it("E-12: an under-18 member on a non-Junior plan is blocked by date of birth", async () => {
    const teen = await makeMember(w, { name: "Teen Silver", plan: "SILVER", dob: "2009-06-01" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: teen.memberId });
    await expect(addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }] })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
  });

  it("BR-5: guest alcohol needs the 'ID verified 18+' tick first", async () => {
    const t = await openTab(w.actors.BAR_STAFF, { guest: { name: "Thirsty Tom" } });
    await expect(addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }] })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    await verifyGuestId(w.actors.BAR_STAFF, t.tabId);
    expect((await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }] })).total).toBe(35000);
    await expectIntegrity();
  });
});

describe("Phase 5 — kitchen display, waiter queue, voids (BR-6, BR-7, E-11)", () => {
  it("BR-6: Send to kitchen → KDS shows 'Table 4 · Kiran' with items and notes; READY → waiter queue → SERVED", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: kiran.memberId, tableId: bar.table4.id });
    await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 1, note: "no onion" }] });
    await sendToKitchen(w.actors.BAR_STAFF, t.tabId);
    const kds = await kitchenQueue(w.actors.BAR_STAFF);
    expect(kds).toHaveLength(1);
    expect([kds[0].table, kds[0].payer, kds[0].lines[0].name, kds[0].lines[0].note]).toEqual([4, "Kiran", "Club sandwich", "no onion"]);
    const lineId = kds[0].lines[0].id;
    await expect(setLineStatus(w.actors.BAR_STAFF, lineId, "READY")).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await setLineStatus(w.actors.BAR_STAFF, lineId, "PREPARING");
    await setLineStatus(w.actors.BAR_STAFF, lineId, "READY");
    const ready = await readyQueue(w.actors.BAR_STAFF);
    expect(ready.map((r) => [r.table, r.payer, r.name])).toEqual([[4, "Kiran", "Club sandwich"]]);
    await setLineStatus(w.actors.BAR_STAFF, lineId, "SERVED");
    expect(await kitchenQueue(w.actors.BAR_STAFF)).toHaveLength(0);
  });

  it("BR-7: before PREPARING bar staff may void; after, only a Manager with a reason", async () => {
    const t = await openTab(w.actors.BAR_STAFF, { guest: { name: "Voider" } });
    const r = await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.fries.id, qty: 1 }, { menuItemId: bar.sandwich.id, qty: 1 }] });
    await voidLine(w.actors.BAR_STAFF, r.lines[0].id, "");
    await sendToKitchen(w.actors.BAR_STAFF, t.tabId);
    await setLineStatus(w.actors.BAR_STAFF, r.lines[1].id, "PREPARING");
    await expect(voidLine(w.actors.BAR_STAFF, r.lines[1].id, "changed mind")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(voidLine(w.actors.MANAGER, r.lines[1].id, "")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const v = await voidLine(w.actors.MANAGER, r.lines[1].id, "customer left");
    expect(v.total).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "tab.void_line", entityId: r.lines[1].id } });
    expect(log.reason).toBe("customer left");
  });
});

describe("Phase 5 — settle, carry, close the day, shifts (BR-8…BR-11, E-13…E-15)", () => {
  it("BR-8: a partial settle leaves the tab OPEN; split cash + UPI settles it; overpayment is rejected", async () => {
    const t = await openTab(w.actors.BAR_STAFF, { guest: { name: "Splitter" } });
    await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 2 }] }); // 640
    const part = await settleTab(w.actors.BAR_STAFF, t.tabId, { payments: [{ method: "CARD", ...CARD_PROOF, amount: 20000 }] });
    expect([part.status, part.due]).toEqual(["OPEN", 44000]);
    await expect(settleTab(w.actors.BAR_STAFF, t.tabId, { payments: [{ method: "CASH", amount: 50000 }] })).rejects.toMatchObject({ code: "OVERPAYMENT" });
    const done = await settleTab(w.actors.BAR_STAFF, t.tabId, { payments: [{ method: "CASH", amount: 24000, tendered: 30000 }, { method: "UPI", reference: utr(), amount: 20000 }] });
    expect([done.status, done.due, done.changeGiven]).toEqual(["SETTLED", 0, 6000]);
    await expectIntegrity();
  });

  it("BR-9: the bar day can't close with open tabs; a Manager carries one over with a reason; BR-11 report adds up", async () => {
    const a = await openTab(w.actors.BAR_STAFF, { guest: { name: "Payer A" } });
    await addLines(w.actors.BAR_STAFF, a.tabId, { items: [{ menuItemId: bar.lime.id, qty: 1 }, { menuItemId: bar.fries.id, qty: 1 }] });
    await settleTab(w.actors.BAR_STAFF, a.tabId, { payments: [{ method: "CASH", amount: 30000 }] });
    const b = await openTab(w.actors.BAR_STAFF, { guest: { name: "Stayer B" } });
    await addLines(w.actors.BAR_STAFF, b.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] });
    await expect(closeBarDay(w.actors.MANAGER, "2026-10-12")).rejects.toMatchObject({ code: "TAB_HAS_BALANCE", message: expect.stringContaining(b.code) });
    await expect(carryTab(w.actors.BAR_STAFF, b.tabId, "regular, pays tomorrow")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await carryTab(w.actors.MANAGER, b.tabId, "regular, pays tomorrow");
    const report = await closeBarDay(w.actors.MANAGER, "2026-10-12");
    expect(report.collected).toBe(30000);
    expect(report.byMethod.CASH).toBe(30000);
    expect(report.byCategory).toEqual({ FOOD: 18000 + 32000, BEVERAGE: 12000, ALCOHOL: 0 });
    expect(report.carriedTabs.map((c) => c.code)).toEqual([b.code]);
    expect((await barDayReport(w.actors.BAR_STAFF, "2026-10-12")).closedAt).not.toBeNull();
    const settledLater = await settleTab(w.actors.BAR_STAFF, b.tabId, { payments: [{ method: "UPI", reference: utr(), amount: 32000 }] });
    expect(settledLater.status).toBe("SETTLED");
  });

  it("BR-10/E-15: bar payments carry received_by and shift; closing the drawer stores the variance", async () => {
    const bina = w.actors.BAR_STAFF;
    const shift = await clockIn(bina, { openingFloat: 200000 });
    const t = await openTab(bina, { guest: { name: "Cash Carl" } });
    await addLines(bina, t.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] });
    await settleTab(bina, t.tabId, { payments: [{ method: "CASH", amount: 32000, tendered: 50000 }] });
    const p = await prisma.payment.findFirstOrThrow({ where: { bill: { sourceType: "BAR_TAB" } } });
    expect([p.receivedBy, p.shiftId]).toEqual([bina.userId, shift.id]);
    await expect(clockOut(bina, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/expected ₹2,320/) });
    const out = await clockOut(bina, { cashCounted: 231000 });
    expect([out.cashExpected, out.cashCounted, out.variance]).toEqual([232000, 231000, -1000]);
  });

  it("the tab view shows the payer, lines with explanations and the balance; members see only their own tab", async () => {
    const m = await makeMember(w, { name: "Viewer", plan: "GOLD" });
    const other = await makeMember(w, { name: "Snoop", plan: "GOLD" });
    const t = await openTab(w.actors.BAR_STAFF, { memberId: m.memberId });
    await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 2 }] });
    const v = await getTab(m.actor, t.tabId);
    expect([v.payer, v.total, v.lines[0].explanation]).toEqual(["Viewer", 59500, "Gold member · 15% bar discount"]);
    await expect(getTab(other.actor, t.tabId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
