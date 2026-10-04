// v5 §1.2–1.4 (ORDER): members order from the portal "Bar & Café" onto their own bar tab (MO-1 … MO-10).
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { login, tokenHash } from "@/server/auth/sessions";
import { addLines, getTab, kitchenQueue, openTab, sendToKitchen, setLineStatus, settleTab, voidLine } from "@/server/services/bar";
import { checkIn, checkOut } from "@/server/services/checkin";
import { myDrawer } from "@/server/services/drawers";
import {
  acceptMemberOrder, cancelMemberLine, incomingOrders, memberMenu, myBar, NOT_AT_CLUB_MESSAGE, placeMemberOrder, recordTableScan, rejectMemberOrder,
  TAB_LIMIT_MESSAGE,
} from "@/server/services/member-orders";
import { updateSetting } from "@/server/services/settings";
import { signTableToken } from "@/server/services/table-token";
import { makeWorld, type World } from "../helpers/world";
import { withFloat } from "../helpers/drawer";
import { makeMember } from "../helpers/members";
import { makeBar } from "../helpers/bar";
import { book } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
let bar: Awaited<ReturnType<typeof makeBar>>;
beforeEach(async () => {
  w = await makeWorld();
  bar = await makeBar(w);
});

type M = Awaited<ReturnType<typeof makeMember>>;

/** A real member login (the session row the table scan is stored on). */
async function loggedIn(m: M) {
  const s = await login(m.member.phone, "member123");
  return s.token;
}

/** Scan the QR card of a bar table on this login. */
async function scan(m: M, token: string, tableId: string) {
  return recordTableScan(m.actor, token, signTableToken(tableId));
}

/** Check the member in for a paid court booking (an open visit today). */
async function checkedIn(m: M) {
  const b = await book(w, { time: "10:30", players: [{ memberId: m.memberId }], payment: { kind: "COUNTER", method: "CASH" } });
  const bp = await prisma.bookingPlayer.findFirstOrThrow({ where: { bookingId: b.bookingId, memberId: m.memberId } });
  await checkIn(w.actors.FRONT_DESK, { bookingPlayerId: bp.id });
}

async function deliveries(event: string, userId: string) {
  const rows = await prisma.notificationDelivery.findMany({ where: { event, userId }, orderBy: { channel: "asc" } });
  return rows.map((r) => `${r.channel}:${r.status}`);
}

describe("v5 §1.3 — MO-1 where the member must be", () => {
  it("MO-1: NOT_AT_CLUB without a table scan or a check-in today (exact message); nothing is written", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await expect(placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token })).rejects.toMatchObject({
      code: "NOT_AT_CLUB",
      message: "Ordering is available when you're at the club. Scan the QR on your table or check in at the front desk.",
    });
    expect(NOT_AT_CLUB_MESSAGE).toBe("Ordering is available when you're at the club. Scan the QR on your table or check in at the front desk.");
    // Without any login token (e.g. a stale client) it is the same answer.
    await expect(placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, {})).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
    expect(await prisma.tab.count()).toBe(0);
    expect(await prisma.memberOrder.count()).toBe(0);
    const view = await myBar(kiran.actor, { sessionToken: token });
    expect([view.ordering.atClub, view.ordering.message]).toEqual([false, NOT_AT_CLUB_MESSAGE]);
    // Staff can't place portal orders.
    await expect(placeMemberOrder(w.actors.BAR_STAFF, { items: [{ menuItemId: bar.lime.id, qty: 1 }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MO-1/MO-2: a valid table scan lets the member order onto a new tab at that table (payer = member); it counts for 3 hours", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    const s = await scan(kiran, token, bar.table4.id);
    expect(s.table.number).toBe(4);
    const session = await prisma.session.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } });
    expect([session.tableId, session.tableScannedAt?.getTime()]).toEqual([bar.table4.id, clock.now().getTime()]);
    expect(await prisma.auditLog.count({ where: { action: "bar.table_scan", entityId: bar.table4.id } })).toBe(1);

    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.fries.id, qty: 2, note: "extra spicy" }] }, { sessionToken: token });
    expect([r.status, r.table, r.total]).toEqual(["PENDING", 4, 32400]); // 2 × ₹180 − Silver 10%
    const tab = await prisma.tab.findUniqueOrThrow({ where: { id: r.tabId } });
    expect([tab.memberId, tab.tableId, tab.status, tab.openedBy]).toEqual([kiran.memberId, bar.table4.id, "OPEN", kiran.actor.userId]);
    const view = await getTab(w.actors.BAR_STAFF, r.tabId);
    expect(view.lines.map((l) => [l.name, l.qty, l.note, l.source, l.awaitingAcceptance, l.explanation])).toEqual([
      ["Masala fries", 2, "extra spicy", "APP", true, "Silver member · 10% bar discount"],
    ]);
    // MO-2 / BR-3: a second order joins the same OPEN tab.
    const again = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    expect(again.tabId).toBe(r.tabId);
    expect(await prisma.tab.count({ where: { memberId: kiran.memberId } })).toBe(1);

    // 3 hours later the scan no longer counts.
    clock.set(new Date(clock.now().getTime() + 3 * 60 * MINUTE + MINUTE));
    await expect(placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token })).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
    // The scan belongs to that login only: another login of the same member has none.
    clock.set(new Date(clock.now().getTime() - 2 * 60 * MINUTE));
    const other = await loggedIn(kiran);
    await expect(placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: other })).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
    await expectIntegrity();
  });

  it("MO-1: a tampered or forged table token is rejected (LINK_INVALID) and stores nothing", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    const good = signTableToken(bar.table4.id);
    const [p, id, mac] = good.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    for (const bad of [`${p}.${id}.${flipped}`, `${p}.${bar.tables[0].id}.${mac}`, `TBL2.${id}.${mac}`, "nonsense", signTableToken("no-such-table")]) {
      await expect(recordTableScan(kiran.actor, token, bad)).rejects.toMatchObject({ code: "LINK_INVALID" });
    }
    const session = await prisma.session.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } });
    expect([session.tableId, session.tableScannedAt]).toEqual([null, null]);
    await expect(placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token })).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
    // Staff scanning a table card are sent to the bar screen instead.
    await expect(recordTableScan(w.actors.BAR_STAFF, token, good)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MO-1: an open check-in visit today lets the member order (no table yet); checked out or yesterday's visit does not", async () => {
    const asha = await makeMember(w, { name: "Asha", plan: "GOLD" });
    const token = await loggedIn(asha);
    await prisma.visit.create({ data: { memberId: asha.memberId, checkedInAt: new Date(clock.now().getTime() - 26 * 60 * MINUTE), byUserId: w.actors.FRONT_DESK.userId } });
    await expect(placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token })).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
    await checkedIn(asha);
    const r = await placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    expect([r.status, r.table, r.total]).toEqual(["PENDING", null, 10200]); // Gold 15%
    const view = await myBar(asha.actor, { sessionToken: token });
    expect([view.ordering.atClub, view.ordering.via]).toEqual([true, "CHECKIN"]);
    // MO-7: the check-out guard still warns about the open tab.
    const out = await checkOut(w.actors.FRONT_DESK, asha.memberId);
    expect(out).toMatchObject({ checkedOut: false, openTab: { id: r.tabId, due: 10200 } });
    await checkOut(w.actors.FRONT_DESK, asha.memberId, { acknowledgeOpenTab: true });
    await expect(placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token })).rejects.toMatchObject({ code: "NOT_AT_CLUB" });
  });
});

describe("v5 §1.3 — MO-3 / MO-4 the bar accepts or rejects", () => {
  it("MO-3: Accept (setting the table) → the order's lines become one kitchen ticket, like Send to kitchen (BR-6); the member is notified", async () => {
    const asha = await makeMember(w, { name: "Asha", plan: "GOLD" });
    const token = await loggedIn(asha);
    await checkedIn(asha);
    const r = await placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.sandwich.id, qty: 1, note: "no onion" }, { menuItemId: bar.lime.id, qty: 2 }] }, { sessionToken: token });
    // Waiting orders never reach the kitchen through the staff "Send to kitchen".
    await expect(sendToKitchen(w.actors.BAR_STAFF, r.tabId)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await kitchenQueue(w.actors.KITCHEN)).toHaveLength(0);
    const inc = await incomingOrders(w.actors.BAR_STAFF);
    expect(inc.orders.map((o) => [o.member.name, o.via, o.table, o.total, o.lines.map((l) => `${l.qty}× ${l.name}`)])).toEqual([
      ["Asha", "CHECKIN", null, 27200 + 20400, ["1× Club sandwich", "2× Fresh lime soda"]],
    ]);
    await expect(acceptMemberOrder(asha.actor, r.orderId, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(incomingOrders(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const a = await acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, { tableId: bar.tables[1].id });
    expect([a.status, a.lines]).toEqual(["ACCEPTED", 2]);
    const order = await prisma.memberOrder.findUniqueOrThrow({ where: { id: r.orderId } });
    expect([order.status, order.decidedBy, order.kitchenTicketId, order.autoAccepted]).toEqual(["ACCEPTED", w.actors.BAR_STAFF.userId, a.ticketId, false]);
    const kds = await kitchenQueue(w.actors.KITCHEN);
    expect(kds.map((t) => [t.ticketId, t.table, t.payer, t.source, t.lines.map((l) => [l.name, l.note, l.source]).sort()])).toEqual([
      [a.ticketId, 2, "Asha", "APP", [["Club sandwich", "no onion", "APP"], ["Fresh lime soda", null, "APP"]]],
    ]);
    expect((await prisma.tab.findUniqueOrThrow({ where: { id: r.tabId } })).tableId).toBe(bar.tables[1].id);
    expect((await incomingOrders(w.actors.BAR_STAFF)).orders).toHaveLength(0);
    expect(await deliveries("BAR_ORDER_ACCEPTED", asha.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    const bell = await prisma.notification.findFirstOrThrow({ where: { userId: asha.actor.userId, type: "BAR_ORDER_ACCEPTED" } });
    expect(bell.body).toMatch(/1× Club sandwich, 2× Fresh lime soda — with the kitchen now, for table 2/);
    await expect(acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, {})).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    expect(await prisma.auditLog.count({ where: { action: "member_order.accept", entityId: r.orderId } })).toBe(1);
  });

  it("MO-3: Reject with a reason voids the order's lines and tells the member why; a tab the app opened for it is closed", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] }, { sessionToken: token });
    await expect(rejectMemberOrder(w.actors.BAR_STAFF, r.orderId, { reason: "OTHER" })).rejects.toThrow();
    const x = await rejectMemberOrder(w.actors.BAR_STAFF, r.orderId, { reason: "MEMBER_NOT_FOUND" });
    expect([x.status, x.voided]).toEqual(["REJECTED", 1]);
    const lines = await prisma.tabLine.findMany({ where: { memberOrderId: r.orderId } });
    expect(lines.map((l) => [l.status, l.voidReason])).toEqual([["VOID", "App order rejected: Member not found at the table"]]);
    const tab = await prisma.tab.findUniqueOrThrow({ where: { id: r.tabId } });
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: tab.billId } });
    expect([tab.status, bill.total]).toEqual(["VOID", 0]);
    expect(await deliveries("BAR_ORDER_REJECTED", kiran.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    const bell = await prisma.notification.findFirstOrThrow({ where: { userId: kiran.actor.userId, type: "BAR_ORDER_REJECTED" } });
    expect([bell.title, bell.body]).toEqual(["Order not accepted", "Sorry — 1× Club sandwich could not be taken: the bar couldn't find you at your table. Nothing was charged for it."]);
    // A new order opens a new tab.
    const r2 = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    expect(r2.tabId).not.toBe(r.tabId);
    await rejectMemberOrder(w.actors.BAR_STAFF, r2.orderId, { reason: "OTHER", note: "Kitchen closing for a private event" });
    expect((await prisma.memberOrder.findUniqueOrThrow({ where: { id: r2.orderId } })).rejectNote).toBe("Kitchen closing for a private event");
    const view = await myBar(kiran.actor, { sessionToken: token });
    expect(view.openTab).toBeNull();
    await expectIntegrity();
  });

  it("MO-3: the panel shows how long each order waits and turns it red after member_order_accept_minutes", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    clock.set(new Date(clock.now().getTime() + 5 * MINUTE));
    let inc = await incomingOrders(w.actors.BAR_STAFF);
    expect([inc.acceptMinutes, inc.orders[0].waitingMinutes, inc.orders[0].overdue, inc.orders[0].table?.number, inc.orders[0].via]).toEqual([5, 5, false, 4, "TABLE"]);
    clock.set(new Date(clock.now().getTime() + MINUTE));
    inc = await incomingOrders(w.actors.BAR_STAFF);
    expect([inc.orders[0].waitingMinutes, inc.orders[0].overdue]).toEqual([6, true]);
    await updateSetting(w.actors.OWNER, "member_order_accept_minutes", 10);
    inc = await incomingOrders(w.actors.BAR_STAFF);
    expect([inc.acceptMinutes, inc.orders[0].overdue]).toEqual([10, false]);
  });

  it("MO-4: auto_accept_member_orders (Owner, off by default) sends table-scan orders straight to the kitchen; check-in orders still wait", async () => {
    await expect(updateSetting(w.actors.MANAGER, "auto_accept_member_orders", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const off = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    expect(off.status).toBe("PENDING");
    await updateSetting(w.actors.OWNER, "auto_accept_member_orders", true);
    const on = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.fries.id, qty: 1 }] }, { sessionToken: token });
    expect(on.status).toBe("ACCEPTED");
    const order = await prisma.memberOrder.findUniqueOrThrow({ where: { id: on.orderId } });
    expect([order.status, order.autoAccepted, order.decidedBy, !!order.kitchenTicketId]).toEqual(["ACCEPTED", true, null, true]);
    const kds = await kitchenQueue(w.actors.KITCHEN);
    expect(kds.map((t) => [t.table, t.source, t.lines.map((l) => l.name)])).toEqual([[4, "APP", ["Masala fries"]]]);
    expect(await deliveries("BAR_ORDER_ACCEPTED", kiran.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    // The earlier order is still waiting for a person.
    expect((await incomingOrders(w.actors.BAR_STAFF)).orders.map((o) => o.id)).toEqual([off.orderId]);

    const asha = await makeMember(w, { name: "Asha", plan: "GOLD" });
    const ashaToken = await loggedIn(asha);
    await checkedIn(asha);
    const viaDesk = await placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: ashaToken });
    expect(viaDesk.status).toBe("PENDING");
  });
});

describe("v5 §1.3 — MO-5 tab limit, MO-6 prices and alcohol", () => {
  it("MO-5: an order that would take the tab above member_tab_limit (₹3,000 by default) → TAB_LIMIT_REACHED (exact message), nothing is added", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const order = (items: Array<{ menuItemId: string; qty: number }>) => placeMemberOrder(kiran.actor, { items }, { sessionToken: token });
    await expect(order([{ menuItemId: bar.sandwich.id, qty: 11 }])).rejects.toMatchObject({ code: "TAB_LIMIT_REACHED", message: "Please settle your tab at the bar to continue ordering." });
    expect(TAB_LIMIT_MESSAGE).toBe("Please settle your tab at the bar to continue ordering.");
    expect(await prisma.tab.count()).toBe(0); // the tab opened for it was rolled back too
    const first = await order([{ menuItemId: bar.sandwich.id, qty: 10 }]); // 10 × ₹288 = ₹2,880
    expect(first.due).toBe(288000);
    expect((await order([{ menuItemId: bar.lime.id, qty: 1 }])).due).toBe(298800); // exactly within ₹3,000
    await expect(order([{ menuItemId: bar.lime.id, qty: 1 }])).rejects.toMatchObject({ code: "TAB_LIMIT_REACHED" });
    expect(await prisma.memberOrder.count()).toBe(2);
    // Staff-entered lines count too; settling part of the tab at the bar lets the member order again.
    await acceptMemberOrder(w.actors.BAR_STAFF, first.orderId, {});
    await settleTab(w.actors.BAR_STAFF, first.tabId, { payments: [{ method: "CASH", amount: 100000 }] });
    expect((await order([{ menuItemId: bar.lime.id, qty: 1 }])).due).toBe(298800 + 10800 - 100000);
    await updateSetting(w.actors.OWNER, "member_tab_limit", 200000);
    await expect(order([{ menuItemId: bar.lime.id, qty: 1 }])).rejects.toMatchObject({ code: "TAB_LIMIT_REACHED" });
    await expectIntegrity();
  });

  it("MO-6: the member's price is the pricing engine's (Silver −10%); a Junior can't see alcohol or order it — also via a guardian or by bypassing the menu", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const menu = await memberMenu(kiran.actor);
    const items = menu.categories.flatMap((c) => c.items);
    const beer = items.find((i) => i.id === bar.beer.id)!;
    expect([beer.price, beer.basePrice, beer.priceNote, menu.alcoholHidden]).toEqual([31500, 35000, "Silver member · 10% bar discount", false]);

    const parent = await makeMember(w, { name: "Parent Priya", plan: "GOLD" });
    const aarav = await makeMember(w, { name: "Aarav", plan: "JUNIOR", dob: "2011-03-01" });
    await prisma.member.update({ where: { id: aarav.memberId }, data: { guardianMemberId: parent.memberId } });
    const juniorMenu = await memberMenu(aarav.actor);
    expect(juniorMenu.alcoholHidden).toBe(true);
    expect(juniorMenu.categories.flatMap((c) => c.items).some((i) => i.isAlcoholic)).toBe(false);
    expect(juniorMenu.categories.flatMap((c) => c.items).map((i) => i.name).sort()).toEqual(["Club sandwich", "Fresh lime soda", "Masala fries"]);
    // The guardian browsing on the Junior's behalf sees the Junior's menu; for themself, the full one.
    expect((await memberMenu(parent.actor, { forMemberId: aarav.memberId })).categories.flatMap((c) => c.items).some((i) => i.isAlcoholic)).toBe(false);
    expect((await memberMenu(parent.actor)).categories.flatMap((c) => c.items).some((i) => i.isAlcoholic)).toBe(true);
    await expect(memberMenu(kiran.actor, { forMemberId: aarav.memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const juniorToken = await loggedIn(aarav);
    await scan(aarav, juniorToken, bar.table4.id);
    await expect(placeMemberOrder(aarav.actor, { items: [{ menuItemId: bar.beer.id, qty: 1 }] }, { sessionToken: juniorToken })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    const parentToken = await loggedIn(parent);
    await scan(parent, parentToken, bar.table4.id);
    await expect(placeMemberOrder(parent.actor, { forMemberId: aarav.memberId, items: [{ menuItemId: bar.beer.id, qty: 1 }] }, { sessionToken: parentToken })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    expect(await prisma.tab.count()).toBe(0);
    // A soft drink for the Junior goes on the Junior's own tab with the Junior discount; the guardian hears about it too.
    const soft = await placeMemberOrder(parent.actor, { forMemberId: aarav.memberId, items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: parentToken });
    expect((await prisma.tab.findUniqueOrThrow({ where: { id: soft.tabId } })).memberId).toBe(aarav.memberId);
    expect(soft.total).toBe(11400); // Junior 5%
    await acceptMemberOrder(w.actors.BAR_STAFF, soft.orderId, {});
    expect(await deliveries("BAR_ORDER_ACCEPTED", parent.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    expect(await deliveries("BAR_ORDER_ACCEPTED", aarav.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    // A sold-out item is refused like at the bar.
    await prisma.menuItem.update({ where: { id: bar.fries.id }, data: { available: false } });
    await expect(placeMemberOrder(parent.actor, { items: [{ menuItemId: bar.fries.id, qty: 1 }] }, { sessionToken: parentToken })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("v5 §1.3 — MO-8 cancel, MO-9 notifications, MO-7 settle, MO-10 labels", () => {
  it("MO-8: a member cancels a NEW line while the order waits, but not once the bar accepted it; never someone else's", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const other = await makeMember(w, { name: "Other Om", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.fries.id, qty: 1 }, { menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    const fries = await prisma.tabLine.findFirstOrThrow({ where: { memberOrderId: r.orderId, menuItemId: bar.fries.id } });
    const lime = await prisma.tabLine.findFirstOrThrow({ where: { memberOrderId: r.orderId, menuItemId: bar.lime.id } });
    await expect(cancelMemberLine(other.actor, fries.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const c = await cancelMemberLine(kiran.actor, fries.id);
    expect([c.orderStatus, c.total]).toEqual(["PENDING", 10800]);
    expect((await prisma.tabLine.findUniqueOrThrow({ where: { id: fries.id } })).status).toBe("VOID");
    await acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, {});
    await expect(cancelMemberLine(kiran.actor, lime.id)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID", message: expect.stringMatching(/already accepted/) });
    // After acceptance only bar staff void it, under the existing rules (BR-7).
    await voidLine(w.actors.BAR_STAFF, lime.id, "member changed mind");
    // Staff lines are never the member's to cancel.
    const staffLine = await addLines(w.actors.BAR_STAFF, r.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] });
    await expect(cancelMemberLine(kiran.actor, staffLine.lines[0].id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Cancelling every line of a waiting order cancels the order (and the empty tab the app opened for it).
    const asha = await makeMember(w, { name: "Asha", plan: "GOLD" });
    const ashaToken = await loggedIn(asha);
    await scan(asha, ashaToken, bar.tables[0].id);
    const o = await placeMemberOrder(asha.actor, { items: [{ menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: ashaToken });
    const only = await prisma.tabLine.findFirstOrThrow({ where: { memberOrderId: o.orderId } });
    expect((await cancelMemberLine(asha.actor, only.id)).orderStatus).toBe("CANCELLED");
    expect((await prisma.tab.findUniqueOrThrow({ where: { id: o.tabId } })).status).toBe("VOID");
    expect((await incomingOrders(w.actors.BAR_STAFF)).orders).toHaveLength(0);
    await expectIntegrity();
  });

  it("MO-9: 'Your order is ready' once every item of the order is READY (in-app + push), once", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.fries.id, qty: 1 }, { menuItemId: bar.lime.id, qty: 1 }] }, { sessionToken: token });
    await acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, {});
    const a = await prisma.tabLine.findFirstOrThrow({ where: { memberOrderId: r.orderId, menuItemId: bar.fries.id } });
    const b = await prisma.tabLine.findFirstOrThrow({ where: { memberOrderId: r.orderId, menuItemId: bar.lime.id } });
    await setLineStatus(w.actors.KITCHEN, a.id, "PREPARING");
    await setLineStatus(w.actors.KITCHEN, a.id, "READY");
    expect(await deliveries("BAR_ORDER_READY", kiran.actor.userId)).toEqual([]);
    await setLineStatus(w.actors.KITCHEN, b.id, "PREPARING");
    await setLineStatus(w.actors.KITCHEN, b.id, "READY");
    expect(await deliveries("BAR_ORDER_READY", kiran.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    const bell = await prisma.notification.findFirstOrThrow({ where: { userId: kiran.actor.userId, type: "BAR_ORDER_READY" } });
    expect([bell.title, bell.body, bell.link]).toEqual(["Your order is ready", "1× Masala fries, 1× Fresh lime soda — coming to table 4.", "/portal/bar"]);
    await setLineStatus(w.actors.BAR_STAFF, a.id, "SERVED");
    expect(await deliveries("BAR_ORDER_READY", kiran.actor.userId)).toHaveLength(2);
    // The portal shows each line's kitchen status.
    const view = await myBar(kiran.actor, { sessionToken: token });
    expect(view.openTab!.lines.map((l) => [l.name, l.status, l.source, l.cancellable])).toEqual([["Masala fries", "SERVED", "APP", false], ["Fresh lime soda", "READY", "APP", false]]);
  });

  it("MO-7/MO-9: settled in cash at the bar → the drawer goes up, the member gets the receipt; the portal shows 'Settle at the bar before you leave'", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] }, { sessionToken: token });
    await acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, {});
    let view = await myBar(kiran.actor, { sessionToken: token });
    expect([view.openTab!.settleNote, view.openTab!.total, view.openTab!.due, view.owed]).toEqual(["Settle at the bar before you leave", 28800, 28800, 28800]);
    expect(view.ordering).toMatchObject({ atClub: true, via: "TABLE", table: { number: 4 } });

    await withFloat(w.actors.BAR_STAFF, 50000, "BAR");
    const before = (await myDrawer(w.actors.BAR_STAFF)).open!.cashExpected;
    const s = await settleTab(w.actors.BAR_STAFF, r.tabId, { payments: [{ method: "CASH", amount: 28800, tendered: 30000 }] });
    expect([s.status, s.changeGiven]).toEqual(["SETTLED", 1200]);
    expect((await myDrawer(w.actors.BAR_STAFF)).open!.cashExpected).toBe(before + 28800);
    const pay = await prisma.payment.findFirstOrThrow({ where: { billId: (await prisma.tab.findUniqueOrThrow({ where: { id: r.tabId } })).billId } });
    const mv = await prisma.drawerMovement.findFirstOrThrow({ where: { paymentId: pay.id } });
    expect([mv.type, mv.amount]).toEqual(["CASH_SALE", 28800]);
    expect(await deliveries("BAR_TAB_SETTLED", kiran.actor.userId)).toEqual(["IN_APP:SENT", "PUSH:SKIPPED"]);
    const bell = await prisma.notification.findFirstOrThrow({ where: { userId: kiran.actor.userId, type: "BAR_TAB_SETTLED" } });
    expect(bell.body).toMatch(/Tab .*: ₹288 paid \(you saved ₹32\)\. Thank you!/);
    view = await myBar(kiran.actor, { sessionToken: token });
    expect(view.openTab).toBeNull();
    expect(view.past.map((p) => [p.id, p.total])).toEqual([[r.tabId, 28800]]);
    await expectIntegrity();
  });

  it("MO-10: staff lines and app lines share the tab and the kitchen display, labelled 'by staff' / 'via app'", async () => {
    const kiran = await makeMember(w, { name: "Kiran", plan: "SILVER" });
    const token = await loggedIn(kiran);
    await scan(kiran, token, bar.table4.id);
    const staffTab = await openTab(w.actors.BAR_STAFF, { memberId: kiran.memberId, tableId: bar.table4.id });
    await addLines(w.actors.BAR_STAFF, staffTab.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }] });
    await sendToKitchen(w.actors.BAR_STAFF, staffTab.tabId);
    const r = await placeMemberOrder(kiran.actor, { items: [{ menuItemId: bar.fries.id, qty: 1 }] }, { sessionToken: token });
    expect(r.tabId).toBe(staffTab.tabId); // BR-3: the same OPEN tab
    await acceptMemberOrder(w.actors.BAR_STAFF, r.orderId, {});
    const tab = await getTab(w.actors.BAR_STAFF, staffTab.tabId);
    expect(tab.lines.map((l) => [l.name, l.source]).sort()).toEqual([["Kingfisher pint", "STAFF"], ["Masala fries", "APP"]]);
    const kds = await kitchenQueue(w.actors.KITCHEN);
    expect(kds.map((t) => [t.lines.map((l) => l.name).join(), t.source]).sort()).toEqual([["Kingfisher pint", "STAFF"], ["Masala fries", "APP"]]);
    const view = await myBar(kiran.actor, { sessionToken: token });
    expect(view.openTab!.lines.map((l) => [l.name, l.source])).toEqual([["Kingfisher pint", "STAFF"], ["Masala fries", "APP"]]);
  });
});
