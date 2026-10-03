// Completion pass phase 5 (P1/P2 extras): guardians, DPDP export/erasure, purchase orders, stock take, calendar
// files, barcodes.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createMember, cancelMembership } from "@/server/services/membership";
import { memberCard } from "@/server/services/members";
import { guardianUserIds, myFamily } from "@/server/services/family";
import { decideErasure, exportMyData, listDataRequests, requestErasure } from "@/server/services/privacy";
import { cancelPurchaseOrder, createPurchaseOrder, markOrdered, postStockTake, receivePurchaseOrder } from "@/server/services/purchasing";
import { listCatalogue, updateVariant } from "@/server/services/shop";
import { login } from "@/server/auth/sessions";
import { icsEvent } from "@/lib/ics";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { book } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;

beforeEach(async () => {
  w = await makeWorld();
});

describe("Completion P1 — guardians", () => {
  it("an under-18 needs a guardian; a member guardian sees the junior, their bookings and card, and gets reminders", async () => {
    await expect(createMember(w.actors.FRONT_DESK, { name: "No Guardian Nia", phone: "9811100001", dob: "2013-03-03" })).rejects.toThrow(/guardian/);
    const parent = await makeMember(w, { name: "Parent Priya", plan: "GOLD" });
    const kid = await createMember(w.actors.FRONT_DESK, { name: "Kid Kabir", phone: "9811100002", dob: "2013-03-03", guardianName: "Parent Priya", guardianPhone: parent.member.phone, plan: { code: "JUNIOR", months: 1, payment: { method: "CASH" } } });
    const other = await makeMember(w, { name: "Other Omar", plan: "SILVER" });
    await book(w, { time: "17:00", players: [{ memberId: kid.memberId }] });
    const fam = await myFamily(parent.actor);
    expect(fam.map((f) => f.name)).toEqual(["Kid Kabir"]);
    expect(fam[0].bookings).toHaveLength(1);
    expect(fam[0].status.tier).toBe("JUNIOR");
    expect((await memberCard(parent.actor, kid.memberId)).memberCode).toMatch(/^CC-/);
    await expect(memberCard(other.actor, kid.memberId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await guardianUserIds([kid.memberId])).toEqual([parent.member.userId]);
    expect(await myFamily(other.actor)).toEqual([]);
  });
});

describe("Completion P1 — DPDP", () => {
  it("a member downloads their data; erasure waits for nothing outstanding, then removes personal details and the login", async () => {
    const m = await makeMember(w, { name: "Erase Esha", plan: "SILVER", email: "esha@example.com", password: "esha-password" });
    const data = await exportMyData(m.actor);
    expect(data.profile).toMatchObject({ name: "Erase Esha", email: "esha@example.com" });
    expect(data.memberships).toHaveLength(1);
    expect(data.bills.length).toBeGreaterThan(0);
    const r = await requestErasure(m.actor, { note: "moving abroad" });
    expect((await requestErasure(m.actor)).id).toBe(r.id); // one open request
    await expect(decideErasure(m.actor, r.id, { approve: true, note: "self" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideErasure(w.actors.OWNER, r.id, { approve: true, note: "requested in writing" })).rejects.toThrow(/current membership/);
    await cancelMembership(w.actors.MANAGER, { membershipId: m.membershipId!, reason: "erasure request" });
    expect((await decideErasure(w.actors.OWNER, r.id, { approve: true, note: "requested in writing" })).status).toBe("DONE");
    const after = await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } });
    expect([after.name.startsWith("Erased member"), after.email, after.anonymisedAt !== null]).toEqual([true, null, true]);
    await expect(login(m.member.phone, "esha-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await prisma.bill.count({ where: { memberId: m.memberId } })).toBeGreaterThan(0); // tax records kept
    expect((await listDataRequests(w.actors.OWNER)).find((x) => x.id === r.id)?.status).toBe("DONE");
    await expectIntegrity();
  });
});

describe("Completion P1 — purchase orders and stock take", () => {
  it("a received PO puts stock on the shelf and creates one supplier bill; a received PO can't be cancelled", async () => {
    const p = await makeProduct(w, { name: "Grip tape", category: "ACCESSORIES", price: 20000, onHand: 2 });
    const po = await createPurchaseOrder(w.actors.SHOP_STAFF, { supplier: "Sports Wholesale", lines: [{ variantId: p.variantId, qty: 10, unitCost: 9000, inputGst: 16200 }] });
    expect(po.code).toMatch(/^PO-\d{6}$/);
    await markOrdered(w.actors.SHOP_STAFF, po.id);
    const r = await receivePurchaseOrder(w.actors.SHOP_STAFF, po.id);
    expect(r.amount).toBe(90000);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })).onHand).toBe(12);
    expect((await prisma.expenseBill.findUniqueOrThrow({ where: { id: r.expenseId! } })).inputGst).toBe(16200);
    await expect(cancelPurchaseOrder(w.actors.SHOP_STAFF, po.id, "too late")).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expect(createPurchaseOrder(w.actors.BAR_STAFF, { supplier: "X Ltd", lines: [{ variantId: p.variantId, qty: 1, unitCost: 1 }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectIntegrity();
  });

  it("a stock take posts each difference as an adjustment and never goes below reserved stock", async () => {
    const a = await makeProduct(w, { name: "Balls can", category: "BALLS", price: 50000, onHand: 10 });
    const b = await makeProduct(w, { name: "Wristband", category: "ACCESSORIES", price: 15000, onHand: 4 });
    const st = await postStockTake(w.actors.SHOP_STAFF, { lines: [{ variantId: a.variantId, counted: 8 }, { variantId: b.variantId, counted: 4 }] });
    expect(st.code).toMatch(/^STK-\d{6}$/);
    expect(st.changed).toBe(1);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: a.variantId } })).onHand).toBe(8);
    await prisma.productVariant.update({ where: { id: b.variantId }, data: { reserved: 3 } });
    await expect(postStockTake(w.actors.SHOP_STAFF, { lines: [{ variantId: b.variantId, counted: 1 }] })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await prisma.productVariant.update({ where: { id: b.variantId }, data: { reserved: 0 } });
    await expectIntegrity();
  });
});

describe("Completion P1/P2 — calendar files and barcodes", () => {
  it("an .ics event carries the booking times in UTC", () => {
    const ics = icsEvent({ uid: "BK-000001@club", start: new Date("2026-10-12T12:30:00Z"), end: new Date("2026-10-12T13:30:00Z"), summary: "Court 1 · Club", location: "1, Road" });
    expect(ics).toContain("DTSTART:20261012T123000Z");
    expect(ics).toContain("DTEND:20261012T133000Z");
    expect(ics).toContain("LOCATION:1\\, Road");
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });

  it("an item's barcode is unique and comes with the catalogue (the till adds by barcode or SKU)", async () => {
    const a = await makeProduct(w, { name: "Shuttle tube", category: "BALLS", price: 30000, onHand: 2 });
    const b = await makeProduct(w, { name: "Grip roll", category: "ACCESSORIES", price: 20000, onHand: 2 });
    await updateVariant(w.actors.SHOP_STAFF, a.variantId, { barcode: "8901234567890" });
    await expect(updateVariant(w.actors.SHOP_STAFF, b.variantId, { barcode: "8901234567890" })).rejects.toThrow(/already on another item/);
    const cat = await listCatalogue();
    expect(cat.flatMap((p) => p.variants).find((v) => v.id === a.variantId)?.barcode).toBe("8901234567890");
    await updateVariant(w.actors.SHOP_STAFF, a.variantId, { barcode: "" });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: a.variantId } })).barcode).toBeNull();
  });
});
