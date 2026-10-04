// v5 §1.1 the bar & café menu builder: categories and items (CRUD, uniqueness, archive), MN-1 base prices by bar
// staff through the price book (promotions stay the Owner's), MN-2 audit + price history, MN-3 snapshots, MN-4 the
// member view / preview, MN-5 the A4 print, MN-6 signed table tokens and QR cards; alcoholic → OUTSIDE_GST + BR-5;
// drafts / sold-out / inactive categories off the bar grid and the member menu.
import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { prisma } from "@/server/db";
import { addLines, createTable, getTab, kitchenQueue, listMenu, openTab, sendToKitchen, settleTab, updateMenuItem } from "@/server/services/bar";
import {
  addLegacyMenuItem, addMenuItem, createMenuCategory, editMenuItem, listMenuCategories, memberMenuView, menuItemDetail, menuPriceHistory, previewMenu,
  printableMenu, removeMenuItemPhoto, reorderMenuCategories, setMenuItemPhoto, setMenuItemStatus, tableQrCards, updateMenuCategory,
} from "@/server/services/menu";
import { createRule, priceBook, setBasePrice } from "@/server/services/price-book";
import { signTableToken, tableCardUrl, verifyTableToken } from "@/server/services/table-token";
import { listView } from "@/server/services/filters";
import { uploadDir } from "@/server/services/uploads";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const bs = () => w.actors.BAR_STAFF;

async function starter() {
  const snacks = await createMenuCategory(bs(), { name: "Snacks", description: "Small plates" });
  const drinks = await createMenuCategory(bs(), { name: "Coolers", icon: "CupSoda" });
  const bar = await createMenuCategory(bs(), { name: "Beers", icon: "Beer" });
  const fries = await addMenuItem(bs(), { name: "Peri peri fries", categoryId: snacks.id, price: 19000, kind: "FOOD", foodType: "VEG", allergens: ["GLUTEN"], prepMinutes: 8 });
  const lime = await addMenuItem(bs(), { name: "Fresh lime soda", categoryId: drinks.id, price: 12000, kind: "DRINK" });
  const beer = await addMenuItem(bs(), { name: "Craft lager pint", categoryId: bar.id, price: 38000, kind: "DRINK", isAlcoholic: true });
  return { snacks, drinks, bar, fries, lime, beer };
}

async function png(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
}

describe("v5 §1.1 — menu CRUD (bar staff build the menu from an empty database)", () => {
  it("MN-CRUD: categories (create, edit, drag to reorder, active) and items with every field; all audited", async () => {
    expect(await prisma.barMenuCategory.count()).toBe(0);
    const s = await starter();
    expect((await listMenuCategories(bs())).map((c) => [c.name, c.items.active])).toEqual([["Snacks", 1], ["Coolers", 1], ["Beers", 1]]);
    await reorderMenuCategories(bs(), { ids: [s.bar.id, s.snacks.id, s.drinks.id] });
    expect((await listMenuCategories(bs())).map((c) => c.name)).toEqual(["Beers", "Snacks", "Coolers"]);
    await expect(reorderMenuCategories(bs(), { ids: [s.bar.id, s.snacks.id] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateMenuCategory(bs(), s.snacks.id, { name: "Snacks & sides", description: null });
    const fries = await menuItemDetail(bs(), s.fries.id);
    expect(fries).toMatchObject({
      name: "Peri peri fries", categoryName: "Snacks & sides", price: 19000, kind: "FOOD", foodType: "VEG", isAlcoholic: false, taxCategory: "RESTAURANT",
      allergens: ["GLUTEN"], prepMinutes: 8, available: true, status: "ACTIVE", photoUrl: null,
    });
    // The old enum kind stays in step for reports and promotions.
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.lime.id } })).category).toBe("BEVERAGE");
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.beer.id } })).category).toBe("ALCOHOL");
    await editMenuItem(bs(), s.fries.id, { description: "Crisp fries, peri peri salt", allergens: ["GLUTEN", "DAIRY"], prepMinutes: 10 });
    expect(await menuItemDetail(bs(), s.fries.id)).toMatchObject({ description: "Crisp fries, peri peri salt", allergens: ["GLUTEN", "DAIRY"], prepMinutes: 10 });
    const actions = (await prisma.auditLog.findMany({ where: { entity: { in: ["menu_item", "menu_category"] } }, select: { action: true } })).map((a) => a.action);
    for (const a of ["menu_category.create", "menu_category.reorder", "menu_category.update", "menu.create", "menu.update"]) expect(actions).toContain(a);
    // Other staff can't touch the menu.
    // v6 SM-1 changed this (was: shop staff too): shop staff now run the café menu (tests/integration/v6-shop.test.ts).
    for (const who of [w.actors.FRONT_DESK, w.actors.KITCHEN, w.actors.ACCOUNTANT]) {
      await expect(createMenuCategory(who, { name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(editMenuItem(who, s.fries.id, { name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // The Manager and the Owner use the same screen.
    await addMenuItem(w.actors.MANAGER, { name: "Masala peanuts", categoryId: s.snacks.id, price: 9000, kind: "FOOD", foodType: "VEG" });
    await addMenuItem(w.actors.OWNER, { name: "Egg roll", categoryId: s.snacks.id, price: 14000, kind: "FOOD", foodType: "EGG" });
    await expectIntegrity();
  });

  it("MN-CRUD: field rules — name 2–60, description ≤ 300, price ₹1–₹50,000, food type required for food and none for drinks", async () => {
    const c = await createMenuCategory(bs(), { name: "Mains" });
    const base = { categoryId: c.id, price: 25000, kind: "FOOD" as const, foodType: "NON_VEG" as const };
    await expect(addMenuItem(bs(), { ...base, name: "X" })).rejects.toThrow(/2–60/);
    await expect(addMenuItem(bs(), { ...base, name: "Y".repeat(61) })).rejects.toThrow(/2–60/);
    await expect(addMenuItem(bs(), { ...base, name: "Long story", description: "d".repeat(301) })).rejects.toThrow(/300/);
    await expect(addMenuItem(bs(), { ...base, name: "Free lunch", price: 0 })).rejects.toThrow(/₹1 – ₹50,000/);
    await expect(addMenuItem(bs(), { ...base, name: "Gold plated", price: 5_000_001 })).rejects.toThrow(/₹1 – ₹50,000/);
    await expect(addMenuItem(bs(), { ...base, name: "Mystery meat", foodType: null })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { field: "foodType" } });
    await expect(addMenuItem(bs(), { ...base, name: "No category", categoryId: "nope" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const edge = await addMenuItem(bs(), { ...base, name: "Ok", price: 100 });
    expect(edge.price).toBe(100);
    expect((await addMenuItem(bs(), { ...base, name: "Feast", price: 5_000_000 })).price).toBe(5_000_000);
    // A drink never carries a food type, even if one is sent.
    const tea = await addMenuItem(bs(), { name: "Masala chai", categoryId: c.id, price: 6000, kind: "DRINK", foodType: "VEG" });
    expect(tea.foodType).toBeNull();
    // Switching a drink to food needs the type.
    await expect(editMenuItem(bs(), tea.id, { kind: "FOOD" })).rejects.toMatchObject({ details: { field: "foodType" } });
    expect((await editMenuItem(bs(), tea.id, { kind: "FOOD", foodType: "VEG" })).category).toBe("FOOD");
  });

  it("MN-CRUD: names are unique within a category ignoring case; the same name in another category is fine; categories are unique too", async () => {
    const a = await createMenuCategory(bs(), { name: "Starters" });
    const b = await createMenuCategory(bs(), { name: "Kids" });
    await expect(createMenuCategory(bs(), { name: "  starters " })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { field: "name" } });
    const item = await addMenuItem(bs(), { name: "Paneer Tikka", categoryId: a.id, price: 32000, kind: "FOOD", foodType: "VEG" });
    await expect(addMenuItem(bs(), { name: "paneer tikka", categoryId: a.id, price: 30000, kind: "FOOD", foodType: "VEG" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { field: "name" } });
    const other = await addMenuItem(bs(), { name: "PANEER TIKKA", categoryId: b.id, price: 20000, kind: "FOOD", foodType: "VEG" });
    // Moving it into the first category (or renaming onto a taken name) is refused too.
    await expect(editMenuItem(bs(), other.id, { categoryId: a.id })).rejects.toMatchObject({ details: { field: "name" } });
    const second = await addMenuItem(bs(), { name: "Hara bhara kebab", categoryId: a.id, price: 26000, kind: "FOOD", foodType: "VEG" });
    await expect(editMenuItem(bs(), second.id, { name: "PANEER tikka" })).rejects.toMatchObject({ details: { field: "name" } });
    // An archived item frees its name; restoring it while the name is taken is refused.
    await setMenuItemStatus(bs(), item.id, { status: "ARCHIVED" });
    const again = await addMenuItem(bs(), { name: "Paneer tikka", categoryId: a.id, price: 34000, kind: "FOOD", foodType: "VEG" });
    await expect(setMenuItemStatus(bs(), item.id, { status: "DRAFT" })).rejects.toMatchObject({ details: { field: "name" } });
    expect(again.status).toBe("ACTIVE");
  });

  it("MN-CRUD: archive never deletes — history and old tab lines keep working; restore returns it as a draft, publish puts it back", async () => {
    const s = await starter();
    const m = await makeMember(w, { name: "Archive Anu", plan: "GOLD" });
    const t = await openTab(bs(), { memberId: m.memberId });
    await addLines(bs(), t.tabId, { items: [{ menuItemId: s.fries.id, qty: 2 }] });
    await setMenuItemStatus(bs(), s.fries.id, { status: "ARCHIVED" });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.fries.id } })).archivedAt).not.toBeNull();
    expect((await listMenu()).map((x) => x.id)).not.toContain(s.fries.id);
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: s.fries.id, qty: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Peri peri fries is not on the menu." });
    await expect(editMenuItem(bs(), s.fries.id, { name: "Renamed" })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    const tab = await getTab(bs(), t.tabId);
    expect(tab.lines.map((l) => [l.name, l.qty, l.netAmount])).toEqual([["Peri peri fries", 2, 32300]]);
    await settleTab(bs(), t.tabId, { payments: [{ method: "CASH", amount: tab.due, tendered: tab.due }] });
    expect(await menuPriceHistory(prisma, s.fries.id)).toHaveLength(1);
    await setMenuItemStatus(bs(), s.fries.id, { status: "DRAFT" });
    expect((await listMenu()).map((x) => x.id)).not.toContain(s.fries.id);
    await setMenuItemStatus(bs(), s.fries.id, { status: "ACTIVE" });
    expect((await listMenu()).map((x) => x.id)).toContain(s.fries.id);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: s.fries.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["menu.create", "menu.archive", "menu.restore", "menu.publish"]));
    expect(await prisma.menuItem.count()).toBe(3);
    await expectIntegrity();
  });
});

describe("v5 MN-1 — menu base prices: Bar staff, Manager and Owner (price book); promotions stay the Owner's", () => {
  it("MN-1: bar staff and the Manager set a base price from the Menu screen (price book MENU target); shop staff and the desk can't", async () => {
    const s = await starter();
    clock.advance(60_000);
    await editMenuItem(bs(), s.lime.id, { price: 13000 });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.lime.id } })).price).toBe(13000);
    clock.advance(60_000);
    await setBasePrice(w.actors.MANAGER, { target: `MENU:${s.lime.id}`, price: 13500 });
    clock.advance(60_000);
    await updateMenuItem(bs(), s.lime.id, { price: 14000 });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.lime.id } })).price).toBe(14000);
    const rows = await prisma.priceChange.findMany({ where: { target: `MENU:${s.lime.id}` }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.price, r.createdBy])).toEqual([
      [12000, bs().userId], [13000, bs().userId], [13500, w.actors.MANAGER.userId], [14000, bs().userId],
    ]);
    // v6 SM-1 changed this (was: shop staff too): shop staff hold `menu.price` like the bar staff.
    for (const who of [w.actors.FRONT_DESK, w.actors.ACCOUNTANT]) {
      await expect(setBasePrice(who, { target: `MENU:${s.lime.id}`, price: 1000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(editMenuItem(w.actors.FRONT_DESK, s.lime.id, { price: 1000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The price book's range rule holds on every path.
    await expect(setBasePrice(bs(), { target: `MENU:${s.lime.id}`, price: 50 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("MN-1: promotions, time bands and other base prices stay Owner-only (FORBIDDEN for bar staff and the Manager)", async () => {
    const s = await starter();
    for (const who of [bs(), w.actors.MANAGER]) {
      await expect(createRule(who, { kind: "PROMOTION", name: "Happy hour", scope: "MENU", startTime: "17:00", endTime: "19:00", adjustType: "PCT", adjustPct: 20 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(createRule(who, { kind: "PROMOTION", name: "Fries deal", scope: "MENU", menuItemIds: [s.fries.id], adjustType: "PCT", adjustPct: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(createRule(who, { kind: "BAND", name: "Peak", scope: "COURTS", daysOfWeek: [1], startTime: "18:00", endTime: "20:00", adjustType: "PCT", adjustPct: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(setBasePrice(who, { target: "COURT_FEE:WALK_IN:TENNIS", price: 10000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(setBasePrice(who, { target: "SOCIAL_FEE:SILVER", price: 10000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(priceBook(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await prisma.priceRule.count()).toBe(0);
    // The Owner still can.
    await createRule(w.actors.OWNER, { kind: "PROMOTION", name: "Happy hour", scope: "MENU", adjustType: "PCT", adjustPct: 20 });
  });
});

describe("v5 MN-2 / MN-3 — price changes are audited, kept in the price book history, and never touch tab lines", () => {
  it("MN-2/MN-3: old → new, who, when in the price book; new lines take the new price at once; existing tab lines keep theirs", async () => {
    const s = await starter();
    const guest = await openTab(bs(), { guest: { name: "Walk-in Wasim" } });
    await addLines(bs(), guest.tabId, { items: [{ menuItemId: s.lime.id, qty: 1 }] });
    await editMenuItem(bs(), s.lime.id, { price: 15000 });
    await addLines(bs(), guest.tabId, { items: [{ menuItemId: s.lime.id, qty: 1 }] });
    const tab = await getTab(bs(), guest.tabId);
    expect(tab.lines.map((l) => l.unitPrice)).toEqual([12000, 15000]);
    expect(tab.total).toBe(27000);
    // History: old → new with who and when.
    const h = await menuPriceHistory(prisma, s.lime.id);
    expect(h.map((r) => [r.oldPrice, r.price, r.by, r.state])).toEqual([[12000, 15000, "Bina Bar", "APPLIED"], [null, 12000, "Bina Bar", "APPLIED"]]);
    // The Owner's price book shows the same change in its history.
    const book = await priceBook(w.actors.OWNER);
    expect(book.history.find((c) => c.target === `MENU:${s.lime.id}` && c.price === 15000)).toMatchObject({ createdBy: bs().userId, oldPrice: 12000, byName: "Bina Bar", label: "Fresh lime soda", kind: "MENU" });
    expect(book.menu.find((m) => m.id === s.lime.id)?.price).toBe(15000);
    // Audited: the menu's own "price" entry (old → new) and the price book's.
    const audits = await prisma.auditLog.findMany({ where: { OR: [{ entityId: s.lime.id, action: "menu.price" }, { action: "price.change" }] } });
    expect(audits.find((a) => a.action === "menu.price")).toMatchObject({ actorId: bs().userId, before: { price: 12000 }, after: { price: 15000 } });
    expect(audits.find((a) => a.action === "price.change")).toMatchObject({ actorId: bs().userId, after: { target: `MENU:${s.lime.id}`, price: 15000 } });
    // Availability toggles are audited too.
    await editMenuItem(bs(), s.lime.id, { available: false });
    await editMenuItem(bs(), s.lime.id, { available: true });
    const toggles = (await prisma.auditLog.findMany({ where: { entityId: s.lime.id, action: { in: ["menu.sold_out", "menu.back_on"] } } })).map((a) => a.action);
    expect(toggles.sort()).toEqual(["menu.back_on", "menu.sold_out"]);
    await expectIntegrity();
  });
});

describe("v5 §1.1 — prep time", () => {
  it("prep minutes are shown to the kitchen (KDS) and to members", async () => {
    const s = await starter();
    const t = await openTab(bs(), { guest: { name: "Hungry Hari" } });
    await addLines(bs(), t.tabId, { items: [{ menuItemId: s.fries.id, qty: 1 }, { menuItemId: s.lime.id, qty: 1 }] });
    await sendToKitchen(bs(), t.tabId);
    const [ticket] = await kitchenQueue(w.actors.KITCHEN);
    expect(ticket.lines.map((l) => [l.name, l.prepMinutes])).toEqual([["Peri peri fries", 8], ["Fresh lime soda", null]]);
    const view = await memberMenuView(prisma, { memberId: null, hideAlcohol: false });
    expect(view.flatMap((c) => c.items).find((i) => i.id === s.fries.id)?.prepMinutes).toBe(8);
  });
});

describe("v5 §1.1 — alcohol and tax", () => {
  it("alcoholic → tax OUTSIDE_GST automatically and the Junior/under-18 block (BR-5); non-alcoholic → the restaurant rate", async () => {
    const s = await starter();
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.beer.id } })).taxCategory).toBe("OUTSIDE_GST");
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.lime.id } })).taxCategory).toBe("RESTAURANT");
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.fries.id } })).taxCategory).toBe("RESTAURANT");
    const junior = await makeMember(w, { name: "Junior Jay", plan: "JUNIOR", dob: "2012-04-04" });
    const t = await openTab(bs(), { memberId: junior.memberId });
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: s.beer.id, qty: 1 }] })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    // Turning a cooler into a cocktail moves it outside GST and under BR-5; back again → restaurant rate.
    const mojito = await editMenuItem(bs(), s.lime.id, { isAlcoholic: true });
    expect([mojito.taxCategory, mojito.category]).toEqual(["OUTSIDE_GST", "ALCOHOL"]);
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: s.lime.id, qty: 1 }] })).rejects.toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
    const back = await editMenuItem(bs(), s.lime.id, { isAlcoholic: false });
    expect([back.taxCategory, back.category]).toEqual(["RESTAURANT", "BEVERAGE"]);
    expect((await addLines(bs(), t.tabId, { items: [{ menuItemId: s.lime.id, qty: 1 }] })).lines).toHaveLength(1);
  });
});

describe("v5 §1.1 — only ACTIVE + available items on the bar grid and to members", () => {
  it("drafts, sold-out items and inactive categories are hidden from the bar grid and the member menu, and can't be added", async () => {
    const s = await starter();
    const draft = await addMenuItem(bs(), { name: "Secret special", categoryId: s.snacks.id, price: 30000, kind: "FOOD", foodType: "NON_VEG", status: "DRAFT" });
    await editMenuItem(bs(), s.lime.id, { available: false });
    const grid = (await listMenu()).map((m) => m.id);
    expect(grid).toEqual(expect.arrayContaining([s.fries.id, s.beer.id]));
    expect(grid).not.toContain(draft.id);
    expect(grid).not.toContain(s.lime.id);
    // Bar Day's sold-out switches still list sold-out ACTIVE items, never drafts.
    expect((await listMenu({ includeUnavailable: true })).map((m) => m.id)).toEqual(expect.arrayContaining([s.lime.id]));
    expect((await listMenu({ includeUnavailable: true })).map((m) => m.id)).not.toContain(draft.id);
    const view = await memberMenuView(prisma, { memberId: null, hideAlcohol: false });
    const ids = view.flatMap((c) => c.items.map((i) => i.id));
    expect(ids).toEqual(expect.arrayContaining([s.fries.id, s.beer.id]));
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(s.lime.id);
    expect(view.map((c) => c.name)).toEqual(["Snacks", "Beers"]); // the Coolers have nothing to show
    const t = await openTab(bs(), { guest: { name: "Grid Guest" } });
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: draft.id, qty: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: s.lime.id, qty: 1 }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: "Fresh lime soda is sold out." });
    // An inactive category takes its items off the grid and the member menu.
    await updateMenuCategory(bs(), s.snacks.id, { active: false });
    expect((await listMenu()).map((m) => m.id)).not.toContain(s.fries.id);
    expect((await memberMenuView(prisma, { memberId: null, hideAlcohol: false })).map((c) => c.name)).toEqual(["Beers"]);
    await expect(addLines(bs(), t.tabId, { items: [{ menuItemId: s.fries.id, qty: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The Menu screen's FilterBar list still shows everything, filterable.
    const all = await listView(bs(), "menu", { status: "ACTIVE,DRAFT,ARCHIVED" });
    expect(all.rows).toHaveLength(4);
    expect((await listView(bs(), "menu", { status: "DRAFT" })).rows.map((r) => r.id)).toEqual([draft.id]);
    expect((await listView(bs(), "menu", { available: "no" })).rows.map((r) => r.id)).toEqual([s.lime.id]);
    expect((await listView(bs(), "menu", { alcoholic: "yes" })).rows.map((r) => r.id)).toEqual([s.beer.id]);
    expect((await listView(bs(), "menu", { food: "VEG" })).rows.map((r) => r.id)).toEqual([s.fries.id]);
    expect((await listView(bs(), "menu", { category: s.bar.id })).rows.map((r) => r.id)).toEqual([s.beer.id]);
    expect((await listView(bs(), "menu", { photo: "yes" })).rows).toHaveLength(0);
    await expect(listView(w.actors.FRONT_DESK, "menu", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v5 §1.1 — one photo per item through the product pipeline", () => {
  it("PNG/JPEG/WebP ≤ 2 MB → 1200 px + 400 px WebP; replace and remove (back to the category icon); bad files refused", async () => {
    const s = await starter();
    const r = await setMenuItemPhoto(bs(), s.fries.id, await png(2400, 1600));
    const meta = async (url: string) => sharp(await readFile(path.join(uploadDir(), "product", url.split("/").pop()!))).metadata();
    expect([(await meta(r.photoUrl!)).width, (await meta(r.photoUrl!)).format, (await meta(r.thumbUrl!)).width]).toEqual([1200, "webp", 400]);
    expect((await listView(bs(), "menu", { photo: "yes" })).rows.map((x) => x.id)).toEqual([s.fries.id]);
    const view = await memberMenuView(prisma, { memberId: null, hideAlcohol: false });
    expect(view.flatMap((c) => c.items).find((i) => i.id === s.fries.id)).toMatchObject({ photoUrl: r.photoUrl, thumbUrl: r.thumbUrl });
    const again = await setMenuItemPhoto(bs(), s.fries.id, await png(300, 300));
    expect(again.photoUrl).not.toBe(r.photoUrl);
    expect((await meta(again.photoUrl!)).width).toBe(300); // never enlarged
    await expect(setMenuItemPhoto(bs(), s.fries.id, Buffer.from("not an image"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(setMenuItemPhoto(bs(), s.fries.id, Buffer.alloc(2 * 1024 * 1024 + 1, 1))).rejects.toThrow(/limit is 2 MB/);
    await expect(setMenuItemPhoto(w.actors.FRONT_DESK, s.fries.id, await png(300, 300))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await removeMenuItemPhoto(bs(), s.fries.id);
    expect(await prisma.menuItem.findUniqueOrThrow({ where: { id: s.fries.id } })).toMatchObject({ photoUrl: null, thumbUrl: null });
    const actions = (await prisma.auditLog.findMany({ where: { entityId: s.fries.id, action: { startsWith: "menu.photo" } } })).map((a) => a.action);
    expect(actions.sort()).toEqual(["menu.photo_remove", "menu.photo_set", "menu.photo_set"]);
  });
});

describe("v5 MN-4 — what members see (and the preview)", () => {
  it("MN-4: the member's own price with the explanation; Junior preview hides alcohol; the preview is the member view", async () => {
    const s = await starter();
    const silver = await makeMember(w, { name: "Silver Sia", plan: "SILVER" });
    await makeMember(w, { name: "Junior Jo", plan: "JUNIOR", dob: "2013-02-02" });
    const view = await memberMenuView(prisma, { memberId: silver.memberId, hideAlcohol: false });
    const fries = view.flatMap((c) => c.items).find((i) => i.id === s.fries.id)!;
    expect(fries).toMatchObject({ price: 17100, basePrice: 19000, priceNote: "Silver member · 10% bar discount", foodType: "VEG", allergens: ["GLUTEN"], prepMinutes: 8 });
    expect(view[0]).toMatchObject({ name: "Snacks", description: "Small plates", icon: "UtensilsCrossed" });
    const walkIn = await memberMenuView(prisma, { memberId: null, hideAlcohol: false });
    expect(walkIn.flatMap((c) => c.items).find((i) => i.id === s.fries.id)).toMatchObject({ price: 19000, basePrice: null, priceNote: null });
    const preview = await previewMenu(bs(), "SILVER");
    expect(preview.categories).toEqual(view);
    const junior = await previewMenu(bs(), "JUNIOR");
    expect(junior.categories.flatMap((c) => c.items).some((i) => i.isAlcoholic)).toBe(false);
    expect(junior.categories.map((c) => c.name)).toEqual(["Snacks", "Coolers"]);
    const gold = await previewMenu(bs(), "GOLD");
    expect(gold.note).toMatch(/No gold member/);
    await expect(previewMenu(w.actors.FRONT_DESK, "SILVER")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v5 MN-5 — the A4 printable menu", () => {
  it("MN-5: club name, active categories in order, ACTIVE items (sold-out too) with food type and price; no drafts", async () => {
    const s = await starter();
    await addMenuItem(bs(), { name: "Draft dish", categoryId: s.snacks.id, price: 10000, kind: "FOOD", foodType: "VEG", status: "DRAFT" });
    await editMenuItem(bs(), s.lime.id, { available: false });
    const m = await printableMenu(bs());
    expect(m.club.name).toBe("The Champions Club");
    expect(m.categories.map((c) => [c.name, c.items.map((i) => [i.name, i.foodType, i.price])])).toEqual([
      ["Snacks", [["Peri peri fries", "VEG", 19000]]],
      ["Coolers", [["Fresh lime soda", null, 12000]]],
      ["Beers", [["Craft lager pint", null, 38000]]],
    ]);
    expect(m.hasAlcohol).toBe(true);
    await expect(printableMenu(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v5 MN-6 — signed table tokens and QR cards", () => {
  it("MN-6: sign → verify round trip; tampered, re-targeted, other-prefix and junk tokens are rejected", async () => {
    const t = await createTable(w.actors.MANAGER, { number: 7, capacity: 4, area: "Terrace" });
    const token = signTableToken(t.id);
    expect(token).toMatch(new RegExp(`^TBL1\\.${t.id}\\.[A-Za-z0-9_-]{32}$`));
    expect(verifyTableToken(token)).toEqual({ tableId: t.id });
    expect(verifyTableToken(encodeURIComponent(token))).toEqual({ tableId: t.id });
    const [p, id, mac] = token.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(verifyTableToken(`${p}.${id}.${flipped}`)).toBeNull();
    const other = await createTable(w.actors.MANAGER, { number: 8, capacity: 4, area: "Terrace" });
    expect(verifyTableToken(`${p}.${other.id}.${mac}`)).toBeNull();
    expect(verifyTableToken(`RF1.${id}.${mac}`)).toBeNull();
    expect(verifyTableToken(`${p}.${id}`)).toBeNull();
    expect(verifyTableToken(`${p}.${id}.${mac}.x`)).toBeNull();
    expect(verifyTableToken("")).toBeNull();
    expect(verifyTableToken("%E0%A4%A")).toBeNull();
    // A different secret signs differently.
    const saved = process.env.APP_SECRET;
    process.env.APP_SECRET = "another-secret-entirely";
    try {
      expect(verifyTableToken(token)).toBeNull();
    } finally {
      process.env.APP_SECRET = saved;
    }
    expect(tableCardUrl(t.id)).toBe(`${(process.env.APP_URL ?? "").replace(/\/$/, "")}/t/${token}`);
  });

  it("MN-6: one printable card per bar table with the QR of <APP_URL>/t/<token>", async () => {
    for (const n of [3, 1, 2]) await createTable(w.actors.MANAGER, { number: n, capacity: 4, area: "Indoor" });
    const r = await tableQrCards(bs());
    expect(r.club.name).toBe("The Champions Club");
    expect(r.cards.map((c) => c.number)).toEqual([1, 2, 3]);
    for (const c of r.cards) {
      expect(c.url).toMatch(/\/t\/TBL1\./);
      expect(verifyTableToken(c.url.split("/t/")[1])).toEqual({ tableId: c.id });
      expect(c.qr).toMatch(/^data:image\/png;base64,/);
    }
    await expect(tableQrCards(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("v5 §1.1 — items from before v5 (seed and the pre-v5 helpers)", () => {
  it("the old shape still works: an ACTIVE item in Food / Drinks / Alcoholic drinks; food without a type can't be published until it has one", async () => {
    const fries = await addLegacyMenuItem(w.actors.MANAGER, { name: "Masala fries", category: "FOOD", price: 18000 });
    const beer = await addLegacyMenuItem(w.actors.MANAGER, { name: "Kingfisher pint", category: "ALCOHOL", price: 35000 });
    const cats = await listMenuCategories(bs());
    expect(cats.map((c) => c.name)).toEqual(["Food", "Alcoholic drinks"]);
    expect([fries.status, fries.foodType, beer.taxCategory, beer.isAlcoholic]).toEqual(["ACTIVE", null, "OUTSIDE_GST", true]);
    expect((await listView(bs(), "menu", { food: "NOT_SET" })).rows.map((r) => r.id)).toEqual([fries.id]);
    await setMenuItemStatus(bs(), fries.id, { status: "DRAFT" });
    await expect(setMenuItemStatus(bs(), fries.id, { status: "ACTIVE" })).rejects.toMatchObject({ details: { field: "foodType" } });
    await editMenuItem(bs(), fries.id, { kind: "FOOD", foodType: "VEG" });
    expect((await setMenuItemStatus(bs(), fries.id, { status: "ACTIVE" })).status).toBe("ACTIVE");
  });
});
