// v5 §1.1 the bar & café menu builder — Bar staff, Manager and Owner (`menu.manage`) build the whole menu from the
// Menu screen with no code or seed changes:
//  • categories: name, optional description, an icon for items without a photo, drag-to-reorder display order,
//    active (never deleted — an inactive category is hidden with its items);
//  • items: name (2–60, unique within the category ignoring case), category, description (≤ 300), one photo through
//    the product photo pipeline (sharp 1200 px + 400 px WebP), price ₹1–₹50,000 (paise), food or drink — food needs a
//    food type (VEG / NON_VEG / EGG), drinks have none —, alcoholic (→ tax OUTSIDE_GST and the BR-5 Junior/under-18
//    block; otherwise the restaurant rate), allergens, prep minutes, available now (sold out) and status
//    DRAFT / ACTIVE / ARCHIVED. Archive never deletes: old tab lines and the price history keep working.
//  • only ACTIVE + available items of an active category reach members and the bar item grid (`isOrderable`).
// MN-1 a base price is written to the price book (`MENU:<id>`, `setBasePriceTx`) by anyone with `menu.price`
// (Bar staff, Manager, Owner) — an explicit exception to v4 RN-3 for menu base prices only; promotions, time bands
// and plan discounts stay `pricing.manage`. MN-2 every change is audited; price changes are price-book rows
// (old → new, who, when). MN-3 a new price applies to new lines at once; tab lines keep their snapshots.
// The old enum `MenuItem.category` (FOOD / BEVERAGE / ALCOHOL) is kept in step as the item's kind for reports,
// promotions and the bar grid tabs.
import type { BarMenuCategory, MenuCategory, MenuItem } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import {
  ALLERGENS, FOOD_TYPES, MENU_DESCRIPTION_MAX, MENU_ICONS, MENU_KINDS, MENU_NAME_MAX, MENU_NAME_MIN, MENU_PREP_MAX, MENU_PRICE_MAX,
  MENU_PRICE_MIN, type MenuKind, type MenuViewCategory,
} from "@/lib/menu";
import { formatINR } from "@/lib/money";
import { qrDataUrl } from "@/lib/qr";
import { dbDate, istDate } from "@/lib/time";
import { pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { assertCapability } from "./capabilities";
import { setBasePriceTx } from "./price-book";
import { quoteBar } from "./pricing";
import { storePhoto, validatePhoto } from "./products";
import { getSettings } from "./settings";
import { tableCardUrl } from "./table-token";

type Db = Tx | typeof prisma;

const HSN_RESTAURANT = "996331";
/** The effective date of an item's opening price (as 0019_v5_menu used for the items that existed before v5). */
const OPENING_PRICE_AT = new Date("2000-01-01T00:00:00Z");

// ───────── rules shared by every path ─────────

/** Food or drink, from the stored item (a FOOD item with no food type yet is still food). */
export const kindOf = (m: { foodType: string | null; category: MenuCategory }): MenuKind => (m.foodType || m.category === "FOOD" ? "FOOD" : "DRINK");

/** The old enum kind kept for reports and promotions. */
const legacyCategory = (kind: MenuKind, alcoholic: boolean): MenuCategory => (alcoholic ? "ALCOHOL" : kind === "FOOD" ? "FOOD" : "BEVERAGE");

/** v5 §1.1: alcoholic → outside GST (and BR-5); everything else → the restaurant rate. */
export const menuTaxCategory = (alcoholic: boolean) => (alcoholic ? "OUTSIDE_GST" : "RESTAURANT");

/** Members and the bar item grid see an item only when this holds. */
export const isOrderable = (m: Pick<MenuItem, "status" | "available">, category?: Pick<BarMenuCategory, "active"> | null) =>
  m.status === "ACTIVE" && m.available && (category?.active ?? true);

const dup = (name: string) => new DomainError("VALIDATION_FAILED", `“${name}” is already on the menu in this category.`, { field: "name" });

async function assertItemNameFree(tx: Tx, categoryId: string, name: string, exceptId?: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM menu_items
     WHERE category_id = ${categoryId} AND lower(btrim(name)) = lower(btrim(${name})) AND status <> 'ARCHIVED' AND id <> ${exceptId ?? ""}
     LIMIT 1`;
  if (rows.length) throw dup(name.trim());
}

async function lockItem(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM menu_items WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Menu item was not found.");
  return tx.menuItem.findUniqueOrThrow({ where: { id } });
}

/** The fields an audit row keeps for an item (no timestamps). */
const auditShape = (m: MenuItem) => ({
  name: m.name, categoryId: m.categoryId, description: m.description, price: m.price, kind: kindOf(m), foodType: m.foodType,
  isAlcoholic: m.isAlcoholic, taxCategory: m.taxCategory, allergens: m.allergens, prepMinutes: m.prepMinutes, available: m.available,
  status: m.status, photoUrl: m.photoUrl,
});

function changed(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

// ───────── categories ─────────

const categoryName = z.string().trim().min(2, "A category name is 2–40 characters.").max(40, "A category name is 2–40 characters.");
const categoryDescription = z.string().trim().max(MENU_DESCRIPTION_MAX, "The description is at most 300 characters.").nullish();

export const categoryInputSchema = z.object({
  name: categoryName,
  description: categoryDescription,
  icon: z.enum(MENU_ICONS).optional(),
  active: z.boolean().optional(),
});
export const categoryPatchSchema = categoryInputSchema.partial();
export const categoryOrderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

async function assertCategoryNameFree(tx: Tx, name: string, exceptId?: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM menu_categories WHERE lower(btrim(name)) = lower(btrim(${name})) AND id <> ${exceptId ?? ""} LIMIT 1`;
  if (rows.length) throw new DomainError("VALIDATION_FAILED", `There is already a “${name.trim()}” category.`, { field: "name" });
}

export async function listMenuCategories(actor: Actor) {
  assertCan(actor, "menu.manage");
  const [cats, counts] = await Promise.all([
    prisma.barMenuCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.menuItem.groupBy({ by: ["categoryId", "status"], _count: { _all: true } }),
  ]);
  const n = (id: string, status: string) => counts.find((c) => c.categoryId === id && c.status === status)?._count._all ?? 0;
  return cats.map((c) => ({
    id: c.id, name: c.name, description: c.description, icon: c.icon, sortOrder: c.sortOrder, active: c.active,
    items: { active: n(c.id, "ACTIVE"), draft: n(c.id, "DRAFT"), archived: n(c.id, "ARCHIVED") },
  }));
}

export async function createMenuCategory(actor: Actor, raw: z.input<typeof categoryInputSchema>, outer?: Tx) {
  assertCan(actor, "menu.manage");
  const input = categoryInputSchema.parse(raw);
  return withTx(async (tx) => {
    await assertCategoryNameFree(tx, input.name);
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(max(sort_order) + 1, 0)::int AS next FROM menu_categories`;
    let c;
    try {
      c = await tx.barMenuCategory.create({
        data: { name: input.name, description: input.description || null, icon: input.icon ?? "UtensilsCrossed", active: input.active ?? true, sortOrder: next },
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", `There is already a “${input.name}” category.`, { field: "name" });
      throw e;
    }
    await audit(tx, actor, "menu_category.create", "menu_category", c.id, { after: { name: c.name, description: c.description, icon: c.icon, active: c.active, sortOrder: c.sortOrder } });
    return c;
  }, outer);
}

export async function updateMenuCategory(actor: Actor, id: string, raw: z.input<typeof categoryPatchSchema>) {
  assertCan(actor, "menu.manage");
  const input = categoryPatchSchema.parse(raw);
  return withTx(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM menu_categories WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw new DomainError("NOT_FOUND", "Category was not found.");
    const before = await tx.barMenuCategory.findUniqueOrThrow({ where: { id } });
    if (input.name !== undefined) await assertCategoryNameFree(tx, input.name, id);
    let after;
    try {
      after = await tx.barMenuCategory.update({
        where: { id },
        data: { name: input.name, description: input.description === undefined ? undefined : input.description || null, icon: input.icon, active: input.active },
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", `There is already a “${input.name}” category.`, { field: "name" });
      throw e;
    }
    const pick = (c: BarMenuCategory) => ({ name: c.name, description: c.description, icon: c.icon, active: c.active });
    const diff = changed(pick(before), pick(after));
    if (Object.keys(diff.after).length) {
      const action = Object.keys(diff.after).length === 1 && "active" in diff.after ? (after.active ? "menu_category.activate" : "menu_category.deactivate") : "menu_category.update";
      await audit(tx, actor, action, "menu_category", id, diff);
    }
    return after;
  });
}

/** Drag to reorder: every category, each once, in the new display order. */
export async function reorderMenuCategories(actor: Actor, raw: z.input<typeof categoryOrderSchema>) {
  assertCan(actor, "menu.manage");
  const { ids } = categoryOrderSchema.parse(raw);
  return withTx(async (tx) => {
    const all = await tx.$queryRaw<{ id: string; sort_order: number }[]>`SELECT id, sort_order FROM menu_categories ORDER BY sort_order, name FOR UPDATE`;
    if (all.length !== ids.length || new Set(ids).size !== ids.length || !all.every((c) => ids.includes(c.id))) {
      throw new DomainError("VALIDATION_FAILED", "Send every category, each once, in the new order.");
    }
    for (const [i, id] of ids.entries()) await tx.barMenuCategory.update({ where: { id }, data: { sortOrder: i } });
    await audit(tx, actor, "menu_category.reorder", "menu_category", "all", { before: { order: all.map((c) => c.id) }, after: { order: ids } });
    return tx.barMenuCategory.findMany({ orderBy: { sortOrder: "asc" } });
  });
}

// ───────── items ─────────

const itemFields = {
  name: z.string().trim().min(MENU_NAME_MIN, "The name is 2–60 characters.").max(MENU_NAME_MAX, "The name is 2–60 characters."),
  categoryId: z.string().min(1, "Choose a category."),
  description: z.string().trim().max(MENU_DESCRIPTION_MAX, "The description is at most 300 characters.").nullish(),
  /** Paise (the screen takes rupees): ₹1 – ₹50,000. */
  price: z.number().int("Enter the price in whole paise.").min(MENU_PRICE_MIN, "The price is ₹1 – ₹50,000.").max(MENU_PRICE_MAX, "The price is ₹1 – ₹50,000."),
  kind: z.enum(MENU_KINDS),
  foodType: z.enum(FOOD_TYPES).nullish(),
  isAlcoholic: z.boolean(),
  allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length),
  prepMinutes: z.number().int().min(1, "Prep time is 1–240 minutes.").max(MENU_PREP_MAX, "Prep time is 1–240 minutes.").nullish(),
  available: z.boolean(),
};

export const menuItemInputSchema = z.object({
  ...itemFields,
  isAlcoholic: itemFields.isAlcoholic.default(false),
  allergens: itemFields.allergens.default([]),
  available: itemFields.available.default(true),
  /** A new item goes live (ACTIVE) or waits as a DRAFT. */
  status: z.enum(["DRAFT", "ACTIVE"]).default("ACTIVE"),
});
export const menuItemPatchSchema = z.object(itemFields).partial();
export const menuItemStatusSchema = z.object({ status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]) });

/** Food needs a food type; a drink has none. Returns the derived columns. */
function shapeKind(kind: MenuKind, foodType: string | null | undefined, alcoholic: boolean) {
  if (kind === "FOOD" && !foodType) throw new DomainError("VALIDATION_FAILED", "Choose Veg, Non-veg or Egg for a food item.", { field: "foodType" });
  return {
    foodType: kind === "FOOD" ? (foodType as (typeof FOOD_TYPES)[number]) : null,
    category: legacyCategory(kind, alcoholic),
    taxCategory: menuTaxCategory(alcoholic),
  };
}

async function assertCategory(tx: Tx, categoryId: string) {
  const c = await tx.barMenuCategory.findUnique({ where: { id: categoryId } });
  if (!c) throw new DomainError("VALIDATION_FAILED", "Choose a category.", { field: "categoryId" });
  return c;
}

/** Create an item. MN-2: its opening price is the first row of its price-book history (who, when). */
export async function addMenuItem(actor: Actor, raw: z.input<typeof menuItemInputSchema>, outer?: Tx) {
  assertCan(actor, "menu.manage");
  assertCan(actor, "menu.price");
  const input = menuItemInputSchema.parse(raw);
  const shaped = shapeKind(input.kind, input.foodType, input.isAlcoholic);
  return withTx(async (tx) => {
    await assertCategory(tx, input.categoryId);
    await assertItemNameFree(tx, input.categoryId, input.name);
    return createItemTx(tx, actor, {
      name: input.name, categoryId: input.categoryId, description: input.description || null, price: input.price, ...shaped,
      isAlcoholic: input.isAlcoholic, allergens: [...new Set(input.allergens)], prepMinutes: input.prepMinutes ?? null,
      available: input.available, status: input.status, hsnSac: HSN_RESTAURANT,
    });
  }, outer);
}

type ItemData = {
  name: string; categoryId: string; description: string | null; price: number; foodType: (typeof FOOD_TYPES)[number] | null; category: MenuCategory;
  taxCategory: string; isAlcoholic: boolean; allergens: Array<(typeof ALLERGENS)[number]>; prepMinutes: number | null; available: boolean;
  status: "DRAFT" | "ACTIVE"; hsnSac: string; sortOrder?: number;
};

async function createItemTx(tx: Tx, actor: Actor, d: ItemData) {
  const sortOrder = d.sortOrder ?? (await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(max(sort_order) + 1, 0)::int AS next FROM menu_items WHERE category_id = ${d.categoryId}`)[0].next;
  let item;
  try {
    item = await tx.menuItem.create({ data: { ...d, sortOrder } });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw dup(d.name);
    throw e;
  }
  // MN-2: the opening price is the first row of the item's price-book history. Like the opening rows 0019 wrote for
  // existing items it is dated before any change can be (so it never ties with a change made in the same instant);
  // who and when it was set are `createdBy` / `createdAt`.
  await tx.priceChange.create({ data: { target: `MENU:${item.id}`, price: d.price, effectiveAt: OPENING_PRICE_AT, note: "Opening price (new menu item)", createdBy: actorId(actor) } });
  await audit(tx, actor, "menu.create", "menu_item", item.id, { after: auditShape(item) });
  return item;
}

/**
 * Edit an item. A price change is a new price-book version in effect now (MN-1, `menu.price`); availability and
 * status have their own audit actions. Tab lines already added keep their prices (MN-3).
 */
export async function editMenuItem(actor: Actor, id: string, raw: z.input<typeof menuItemPatchSchema>) {
  assertCan(actor, "menu.manage");
  const input = menuItemPatchSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await lockItem(tx, id);
    if (before.status === "ARCHIVED" && Object.entries(input).some(([k, v]) => k !== "available" && v !== undefined)) {
      throw new DomainError("ORDER_STATE_INVALID", `${before.name} is archived — restore it to edit it.`);
    }
    const kind = input.kind ?? kindOf(before);
    const alcoholic = input.isAlcoholic ?? before.isAlcoholic;
    const kindTouched = input.kind !== undefined || input.foodType !== undefined || input.isAlcoholic !== undefined;
    const shaped = kindTouched ? shapeKind(kind, input.foodType === undefined ? before.foodType : input.foodType, alcoholic) : null;
    const categoryId = input.categoryId ?? before.categoryId;
    if (input.categoryId !== undefined && input.categoryId !== before.categoryId) await assertCategory(tx, input.categoryId);
    const name = input.name ?? before.name;
    if (input.name !== undefined || input.categoryId !== undefined) await assertItemNameFree(tx, categoryId, name, id);

    // MN-1: the base price lives in the price book; syncRecord keeps menu_items.price in step.
    if (input.price !== undefined && input.price !== before.price) {
      assertCan(actor, "menu.price");
      await setBasePriceTx(tx, actor, { target: `MENU:${id}`, price: input.price, note: `Menu: ${formatINR(before.price)} → ${formatINR(input.price)}` });
      await audit(tx, actor, "menu.price", "menu_item", id, { before: { price: before.price }, after: { price: input.price } });
    }
    let after;
    try {
      after = await tx.menuItem.update({
        where: { id },
        data: {
          name: input.name, categoryId: input.categoryId, description: input.description === undefined ? undefined : input.description || null,
          allergens: input.allergens ? [...new Set(input.allergens)] : undefined,
          prepMinutes: input.prepMinutes === undefined ? undefined : input.prepMinutes ?? null,
          available: input.available, isAlcoholic: input.isAlcoholic, ...(shaped ?? {}),
        },
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw dup(name);
      throw e;
    }
    const b = auditShape(before);
    const a = auditShape(after);
    if (b.available !== a.available) await audit(tx, actor, a.available ? "menu.back_on" : "menu.sold_out", "menu_item", id, { before: { available: b.available }, after: { available: a.available } });
    const rest = changed({ ...b, available: undefined, price: undefined }, { ...a, available: undefined, price: undefined });
    if (Object.keys(rest.after).length) await audit(tx, actor, "menu.update", "menu_item", id, rest);
    return after;
  });
}

/** Sold out / back on, without archiving (BR-1). */
export async function setMenuItemAvailability(actor: Actor, id: string, available: boolean) {
  return editMenuItem(actor, id, { available });
}

/** DRAFT ↔ ACTIVE, ARCHIVED (never deleted: old tab lines and the history keep working), and restore (→ DRAFT). */
export async function setMenuItemStatus(actor: Actor, id: string, raw: z.input<typeof menuItemStatusSchema>) {
  assertCan(actor, "menu.manage");
  const { status } = menuItemStatusSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await lockItem(tx, id);
    if (before.status === status) return before;
    if (before.status === "ARCHIVED") {
      // Restoring: the name must still be free in its category.
      await assertItemNameFree(tx, before.categoryId, before.name, id);
    }
    if (status === "ACTIVE" && kindOf(before) === "FOOD" && !before.foodType) {
      throw new DomainError("VALIDATION_FAILED", `Set Veg, Non-veg or Egg for ${before.name} before it goes on the menu.`, { field: "foodType" });
    }
    let after;
    try {
      after = await tx.menuItem.update({ where: { id }, data: { status, archivedAt: status === "ARCHIVED" ? clock.now() : null } });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw dup(before.name);
      throw e;
    }
    const action = status === "ARCHIVED" ? "menu.archive" : before.status === "ARCHIVED" ? "menu.restore" : status === "ACTIVE" ? "menu.publish" : "menu.unpublish";
    await audit(tx, actor, action, "menu_item", id, { before: { status: before.status }, after: { status } });
    return after;
  });
}

/** One photo per item (PNG/JPEG/WebP ≤ 2 MB) through the product pipeline; a new photo replaces the old one. */
export async function setMenuItemPhoto(actor: Actor, id: string, data: Buffer) {
  assertCan(actor, "menu.manage");
  await assertCapability("photos.upload");
  const meta = await validatePhoto(data);
  if (!(await prisma.menuItem.findUnique({ where: { id }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Menu item was not found.");
  const { url, thumbUrl } = await storePhoto(data);
  return withTx(async (tx) => {
    const before = await lockItem(tx, id);
    const after = await tx.menuItem.update({ where: { id }, data: { photoUrl: url, thumbUrl } });
    await audit(tx, actor, "menu.photo_set", "menu_item", id, { before: { photoUrl: before.photoUrl }, after: { photoUrl: url, thumbUrl, bytes: data.length, width: meta.width, height: meta.height } });
    return { id, photoUrl: after.photoUrl, thumbUrl: after.thumbUrl };
  });
}

/** Back to the category icon. */
export async function removeMenuItemPhoto(actor: Actor, id: string) {
  assertCan(actor, "menu.manage");
  return withTx(async (tx) => {
    const before = await lockItem(tx, id);
    if (!before.photoUrl) return { id, photoUrl: null, thumbUrl: null };
    await tx.menuItem.update({ where: { id }, data: { photoUrl: null, thumbUrl: null } });
    await audit(tx, actor, "menu.photo_remove", "menu_item", id, { before: { photoUrl: before.photoUrl } });
    return { id, photoUrl: null, thumbUrl: null };
  });
}

/** MN-2: the item's price-book history, newest first — old → new, who, when (scheduled changes included). */
export async function menuPriceHistory(db: Db, id: string) {
  const rows = await db.priceChange.findMany({ where: { target: `MENU:${id}` }, orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }] });
  const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdBy).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const now = clock.now();
  const out = [];
  let prev: number | null = null;
  for (const r of rows) {
    out.push({
      // An opening price is dated 2000-01-01 so it never ties with a change; show when it was really set.
      id: r.id, oldPrice: prev, price: r.price, effectiveAt: r.effectiveAt < r.createdAt && prev === null ? r.createdAt : r.effectiveAt, createdAt: r.createdAt, note: r.note,
      by: r.createdBy ? users.find((u) => u.id === r.createdBy)?.name ?? "Staff" : null,
      state: r.cancelledAt ? "WITHDRAWN" : r.effectiveAt > now ? "SCHEDULED" : "APPLIED",
    });
    if (!r.cancelledAt) prev = r.price;
  }
  return out.reverse();
}

/** One item for the Menu screen's editor, with its price history. */
export async function menuItemDetail(actor: Actor, id: string) {
  assertCan(actor, "menu.manage");
  const m = await prisma.menuItem.findUnique({ where: { id }, include: { menuCategory: true } });
  if (!m) throw new DomainError("NOT_FOUND", "Menu item was not found.");
  const tabLines = await prisma.tabLine.count({ where: { menuItemId: id } });
  return {
    id: m.id, name: m.name, categoryId: m.categoryId, categoryName: m.menuCategory.name, categoryIcon: m.menuCategory.icon, description: m.description,
    price: m.price, kind: kindOf(m), foodType: m.foodType, isAlcoholic: m.isAlcoholic, taxCategory: m.taxCategory, allergens: m.allergens,
    prepMinutes: m.prepMinutes, available: m.available, status: m.status, photoUrl: m.photoUrl, thumbUrl: m.thumbUrl, archivedAt: m.archivedAt,
    tabLines, canPrice: can(actor, "menu.price"), priceHistory: await menuPriceHistory(prisma, id),
  };
}

// ───────── what members see (MN-4; the portal "Bar & Café" uses the same) ─────────

/**
 * The menu for one viewer: active categories in display order with their ACTIVE + available items, each priced by
 * the pricing engine for this member now (their bar discount, any promotion). `hideAlcohol` removes alcoholic items
 * (Juniors / under 18 — the caller decides, and ordering still rejects them server-side).
 */
export async function memberMenuView(db: Db, opts: { memberId: string | null; hideAlcohol: boolean; at?: Date }): Promise<MenuViewCategory[]> {
  const cats = await db.barMenuCategory.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { items: { where: { status: "ACTIVE", available: true, ...(opts.hideAlcohol ? { isAlcoholic: false } : {}) }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  const items = cats.flatMap((c) => c.items);
  const at = opts.at ?? clock.now();
  const quote = items.length
    ? await quoteBar(db, {
      memberId: opts.memberId, date: istDate(at), at,
      items: items.map((i) => ({ menuItemId: i.id, qty: 1, name: i.name, price: i.price, taxCategory: i.taxCategory, hsnSac: i.hsnSac })),
    })
    : null;
  const priced = new Map(items.map((i, idx) => [i.id, quote!.lines[idx]]));
  return cats
    .filter((c) => c.items.length)
    .map((c) => ({
      id: c.id, name: c.name, description: c.description, icon: c.icon,
      items: c.items.map((i) => {
        const l = priced.get(i.id)!;
        const discounted = l.netAmount !== l.unitPrice;
        return {
          id: i.id, name: i.name, description: i.description, photoUrl: i.photoUrl, thumbUrl: i.thumbUrl, foodType: i.foodType, isAlcoholic: i.isAlcoholic,
          allergens: i.allergens, prepMinutes: i.prepMinutes, price: l.netAmount, basePrice: discounted ? l.unitPrice : null, priceNote: discounted ? l.explanation : null,
        };
      }),
    }));
}

export const PREVIEW_AS = ["GOLD", "SILVER", "JUNIOR", "NONE"] as const;
export type PreviewAs = (typeof PREVIEW_AS)[number];

/**
 * MN-4 "Preview as member": exactly what a member of the chosen plan sees now — priced for a real member on that plan
 * today (the same way the price simulator picks one); Junior hides alcohol. "NONE" = a member without a plan.
 */
export async function previewMenu(actor: Actor, as: PreviewAs = "SILVER") {
  assertCan(actor, "menu.manage");
  if (!PREVIEW_AS.includes(as)) throw new DomainError("VALIDATION_FAILED", "Choose who to preview as.");
  const today = istDate(clock.now());
  let memberId: string | null = null;
  if (as !== "NONE") {
    const m = await prisma.membership.findFirst({
      where: { plan: { code: as }, status: "ACTIVE", startDate: { lte: dbDate(today) }, endDate: { gte: dbDate(today) } },
      select: { memberId: true },
    });
    memberId = m?.memberId ?? null;
  }
  const categories = await memberMenuView(prisma, { memberId, hideAlcohol: as === "JUNIOR", at: clock.now() });
  const label = as === "NONE" ? "a member without a plan" : `a ${as.charAt(0)}${as.slice(1).toLowerCase()} member`;
  return {
    as,
    label,
    pricedFor: as === "NONE" || memberId ? label : null,
    note: as !== "NONE" && !memberId ? `No ${as.toLowerCase()} member has a plan today, so prices are shown without a plan discount.` : null,
    categories,
  };
}

// ───────── print (MN-5) and table QR cards (MN-6) ─────────

/** MN-5: the A4 menu — active categories and ACTIVE items (sold-out ones too: a printed menu outlives today), base prices. */
export async function printableMenu(actor: Actor) {
  assertCan(actor, "menu.manage");
  const s = await getSettings();
  const cats = await prisma.barMenuCategory.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { items: { where: { status: "ACTIVE" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  return {
    club: { name: s.club.name, logoUrl: s.club.logo_url || null, address: s.club.address, phone: s.club.phone },
    categories: cats.filter((c) => c.items.length).map((c) => ({
      id: c.id, name: c.name, description: c.description, icon: c.icon,
      items: c.items.map((i) => ({ id: i.id, name: i.name, description: i.description, foodType: i.foodType, isAlcoholic: i.isAlcoholic, allergens: i.allergens, prepMinutes: i.prepMinutes, price: i.price })),
    })),
    hasAlcohol: cats.some((c) => c.items.some((i) => i.isAlcoholic)),
  };
}

/** MN-6: one printable card per bar table — its signed token QR (`<APP_URL>/t/TBL1.<tableId>.<hmac>`). */
export async function tableQrCards(actor: Actor) {
  assertCan(actor, "menu.manage");
  const s = await getSettings();
  const tables = await prisma.barTable.findMany({ orderBy: { number: "asc" } });
  const cards = [];
  for (const t of tables) {
    const url = tableCardUrl(t.id);
    cards.push({ id: t.id, number: t.number, area: t.area, capacity: t.capacity, url, qr: await qrDataUrl(url) });
  }
  return { club: { name: s.club.name, logoUrl: s.club.logo_url || null }, cards };
}

// ───────── compatibility: the pre-v5 shape (seed, tests and the bar's own helpers) ─────────

const LEGACY_CATEGORY: Record<MenuCategory, { id: string; name: string; icon: string; sortOrder: number }> = {
  FOOD: { id: "mc_food", name: "Food", icon: "UtensilsCrossed", sortOrder: 0 },
  BEVERAGE: { id: "mc_beverage", name: "Drinks", icon: "CupSoda", sortOrder: 1 },
  ALCOHOL: { id: "mc_alcohol", name: "Alcoholic drinks", icon: "Wine", sortOrder: 2 },
};

/** The category the migration made for an old enum value (found by name, created when missing). */
export async function legacyMenuCategoryTx(tx: Tx, actor: Actor, c: MenuCategory) {
  const spec = LEGACY_CATEGORY[c];
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM menu_categories WHERE lower(btrim(name)) = lower(${spec.name}) LIMIT 1`;
  if (rows.length) return rows[0].id;
  const created = await createMenuCategory(actor, { name: spec.name, icon: spec.icon as (typeof MENU_ICONS)[number] }, tx);
  return created.id;
}

export const legacyMenuItemSchema = z.object({
  name: z.string().trim().min(MENU_NAME_MIN).max(MENU_NAME_MAX),
  category: z.enum(["FOOD", "BEVERAGE", "ALCOHOL"]),
  price: z.number().int().min(MENU_PRICE_MIN).max(MENU_PRICE_MAX),
  isAlcoholic: z.boolean().optional(),
  foodType: z.enum(FOOD_TYPES).optional(),
  hsnSac: z.string().trim().min(4).max(10).default(HSN_RESTAURANT),
  sortOrder: z.number().int().optional(),
});

/** Pre-v5 callers: an ACTIVE item in the Food / Drinks / Alcoholic drinks category. A FOOD item may come without a food type (the Menu screen asks for it). */
export async function addLegacyMenuItem(actor: Actor, raw: z.input<typeof legacyMenuItemSchema>, outer?: Tx) {
  assertCan(actor, "menu.manage");
  assertCan(actor, "menu.price");
  const input = legacyMenuItemSchema.parse(raw);
  return withTx(async (tx) => {
    const alcoholic = input.isAlcoholic ?? input.category === "ALCOHOL";
    const categoryId = await legacyMenuCategoryTx(tx, actor, input.category);
    await assertItemNameFree(tx, categoryId, input.name);
    return createItemTx(tx, actor, {
      name: input.name, categoryId, description: null, price: input.price, foodType: input.category === "FOOD" ? input.foodType ?? null : null,
      category: alcoholic ? "ALCOHOL" : input.category === "ALCOHOL" ? "BEVERAGE" : input.category, taxCategory: menuTaxCategory(alcoholic),
      isAlcoholic: alcoholic, allergens: [], prepMinutes: null, available: true, status: "ACTIVE", hsnSac: input.hsnSac, sortOrder: input.sortOrder,
    });
  }, outer);
}
