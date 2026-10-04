// v3 §9.3 product management (Shop staff, Manager, Owner). Extends the existing product admin (createProduct and
// updateVariant in shop.ts): details, up to five photos (resized on the server with sharp to 1200 px plus a 400 px
// thumbnail), variants, archive/restore instead of delete, and an inline product promotion through the price book
// (shop staff up to `max_staff_discount_pct`, above that it waits for approval). Stock is never edited here — only
// receipts, stock takes and adjustments change it. D-79: shop staff also set shop prices (price book) and shop
// discounts (`shop.pricing`).
import type { PriceRule } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { fromDbDate } from "@/lib/time";
import { prisma, pgErrorCode, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { assertCapability } from "./capabilities";
import { createRule, endRule, type RuleInput } from "./price-book";
import { rulesInEffect, ruleWindow } from "./pricing";
import { getSettings } from "./settings";
import { defaultGoodsCategory } from "./shop";
import { MAX_UPLOAD_BYTES, uploadDir } from "./uploads";

export const MAX_PRODUCT_PHOTOS = 5;
const CATEGORIES = ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"] as const;

export const productDetailsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  brand: z.string().trim().max(60).optional(),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(2000, "The description is at most 2,000 characters.").optional(),
  isRestring: z.boolean().optional(),
});

async function lockProduct(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Product was not found.");
  return tx.product.findUniqueOrThrow({ where: { id }, include: { variants: true } });
}

export async function updateProductDetails(actor: Actor, id: string, raw: z.infer<typeof productDetailsSchema>) {
  assertCan(actor, "shop.stock");
  const input = productDetailsSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await lockProduct(tx, id);
    const after = await tx.product.update({ where: { id }, data: input });
    await audit(tx, actor, "product.update", "product", id, { before: { name: before.name, brand: before.brand, category: before.category, description: before.description, isRestring: before.isRestring }, after: input });
    return after;
  });
}

// ───────── photos ─────────

/** The cover (first photo) is also the product's image everywhere the shop shows one. */
async function syncCover(tx: Tx, productId: string) {
  const first = await tx.productImage.findFirst({ where: { productId }, orderBy: { sort: "asc" } });
  await tx.product.update({ where: { id: productId }, data: { imageUrl: first?.url ?? null } });
}

async function writeImage(buf: Buffer) {
  const name = `${randomBytes(12).toString("hex")}.webp`;
  const dir = path.join(uploadDir(), "product");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(/* turbopackIgnore: true */ dir, name), buf, { flag: "wx" });
  return `/api/uploads/product/${name}`;
}

/** The photo pipeline's check (shared with v5 menu items): a PNG/JPEG/WebP image of at most 2 MB. */
export async function validatePhoto(data: Buffer) {
  if (!data.length) throw new DomainError("VALIDATION_FAILED", "The file is empty.");
  if (data.length > MAX_UPLOAD_BYTES) throw new DomainError("VALIDATION_FAILED", `The file is ${(data.length / 1_048_576).toFixed(1)} MB; the limit is 2 MB.`);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(data).metadata();
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Upload a PNG, JPEG or WebP image.");
  }
  if (!["png", "jpeg", "webp"].includes(meta.format ?? "")) throw new DomainError("VALIDATION_FAILED", "Upload a PNG, JPEG or WebP image.");
  return meta;
}

/** The photo pipeline's output (shared with v5 menu items): a 1200 px image and a 400 px thumbnail, never larger than sent. */
export async function storePhoto(data: Buffer) {
  const large = await sharp(data).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await sharp(data).rotate().resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return { url: await writeImage(large), thumbUrl: await writeImage(thumb) };
}

/** Add a photo (PNG/JPEG/WebP ≤ 2 MB): stored as a 1200 px image and a 400 px thumbnail, never larger than sent. */
export async function addProductPhoto(actor: Actor, productId: string, data: Buffer) {
  assertCan(actor, "shop.stock");
  await assertCapability("photos.upload");
  const meta = await validatePhoto(data);
  const count = await prisma.productImage.count({ where: { productId } });
  if (count >= MAX_PRODUCT_PHOTOS) throw new DomainError("VALIDATION_FAILED", `A product has at most ${MAX_PRODUCT_PHOTOS} photos. Remove one first.`);
  const { url, thumbUrl } = await storePhoto(data);
  return withTx(async (tx) => {
    await lockProduct(tx, productId);
    const n = await tx.productImage.count({ where: { productId } });
    if (n >= MAX_PRODUCT_PHOTOS) throw new DomainError("VALIDATION_FAILED", `A product has at most ${MAX_PRODUCT_PHOTOS} photos. Remove one first.`);
    const img = await tx.productImage.create({ data: { productId, url, thumbUrl, sort: n } });
    await syncCover(tx, productId);
    await audit(tx, actor, "product.photo_add", "product", productId, { after: { url, thumbUrl, sort: n, bytes: data.length, width: meta.width, height: meta.height } });
    return img;
  });
}

/** Drag to reorder: the first becomes the cover. */
export async function reorderProductPhotos(actor: Actor, productId: string, ids: string[]) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    await lockProduct(tx, productId);
    const imgs = await tx.productImage.findMany({ where: { productId } });
    if (imgs.length !== ids.length || !imgs.every((i) => ids.includes(i.id))) throw new DomainError("VALIDATION_FAILED", "Send every photo of this product, in the new order.");
    for (const [i, id] of ids.entries()) await tx.productImage.update({ where: { id }, data: { sort: 100 + i } });
    for (const [i, id] of ids.entries()) await tx.productImage.update({ where: { id }, data: { sort: i } });
    await syncCover(tx, productId);
    await audit(tx, actor, "product.photo_reorder", "product", productId, { after: { order: ids } });
    return tx.productImage.findMany({ where: { productId }, orderBy: { sort: "asc" } });
  });
}

export async function removeProductPhoto(actor: Actor, productId: string, imageId: string) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    await lockProduct(tx, productId);
    const img = await tx.productImage.findFirst({ where: { id: imageId, productId } });
    if (!img) throw new DomainError("NOT_FOUND", "Photo was not found.");
    await tx.productImage.delete({ where: { id: imageId } });
    const rest = await tx.productImage.findMany({ where: { productId }, orderBy: { sort: "asc" } });
    for (const [i, r] of rest.entries()) await tx.productImage.update({ where: { id: r.id }, data: { sort: i } });
    await syncCover(tx, productId);
    await audit(tx, actor, "product.photo_remove", "product", productId, { before: { url: img.url } });
    return { removed: imageId };
  });
}

// ───────── variants ─────────

export const newVariantSchema = z.object({
  sku: z.string().trim().min(3).max(40),
  label: z.string().trim().min(1).max(60),
  price: z.number().int().min(0),
  reorderLevel: z.number().int().min(0).optional(),
  taxCategory: z.enum(["GOODS_5", "GOODS_18", "SERVICE"]).optional(),
  hsnSac: z.string().trim().min(4).max(10),
});

export async function addVariant(actor: Actor, productId: string, raw: z.infer<typeof newVariantSchema>) {
  assertCan(actor, "shop.stock");
  assertCan(actor, "shop.pricing"); // a new size/colour comes with its price
  const input = newVariantSchema.parse(raw);
  return withTx(async (tx) => {
    const p = await lockProduct(tx, productId);
    const s = await getSettings(tx);
    const isService = p.category === "SERVICES";
    try {
      const v = await tx.productVariant.create({
        data: {
          productId, sku: input.sku.toUpperCase(), label: input.label, price: input.price, reorderLevel: isService ? 0 : (input.reorderLevel ?? s.default_reorder_level),
          taxCategory: input.taxCategory ?? (isService ? "SERVICE" : defaultGoodsCategory(p.category, input.hsnSac, input.price)), hsnSac: input.hsnSac,
        },
      });
      await audit(tx, actor, "variant.create", "product_variant", v.id, { after: { productId, sku: v.sku, label: v.label, price: v.price } });
      return v;
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", `SKU ${input.sku.toUpperCase()} is already in use.`);
      throw e;
    }
  });
}

// ───────── archive / restore ─────────

/** Remove = archive: hidden from sale, history and stock reports kept. Not while online orders hold its stock. */
export async function archiveProduct(actor: Actor, id: string) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    const p = await lockProduct(tx, id);
    if (p.archivedAt) return { id, archivedAt: p.archivedAt };
    const held = p.variants.reduce((a, v) => a + v.reserved, 0);
    if (held > 0) throw new DomainError("PRODUCT_HAS_RESERVATIONS", `${p.name} has ${held} unit${held === 1 ? "" : "s"} held for open online orders. Hand them over or cancel those orders first.`, { reserved: held });
    const now = clock.now();
    await tx.product.update({ where: { id }, data: { archivedAt: now } });
    await audit(tx, actor, "product.archive", "product", id, { before: { archivedAt: null }, after: { archivedAt: now } });
    return { id, archivedAt: now };
  });
}

export async function restoreProduct(actor: Actor, id: string) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    const p = await lockProduct(tx, id);
    await tx.product.update({ where: { id }, data: { archivedAt: null } });
    await audit(tx, actor, "product.restore", "product", id, { before: { archivedAt: p.archivedAt }, after: { archivedAt: null } });
    return { id, archivedAt: null };
  });
}

// ───────── shop discounts: price-book promotions on shop products (same model and guardrails as the price book) ─────────
// D-79: shop staff (`shop.pricing`) create and end them for one product, some categories or the whole shop; up to
// `max_staff_discount_pct` they start at once, above it they wait for the Owner (decideRule; v4 RN-3 — no manager
// approvals). Never another scope.

export const productPromotionSchema = z.object({
  name: z.string().trim().min(2).max(60),
  pct: z.number().int().min(1).max(100),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  audience: z.enum(["ALL", "TIERS", "WALK_IN"]).default("ALL"),
  tiers: z.array(z.enum(["GOLD", "SILVER", "JUNIOR", "WALK_IN"])).default([]),
});

function discountRule(input: z.infer<typeof productPromotionSchema>, target: { productIds?: string[]; productCategories?: string[] }): RuleInput {
  if (input.dateFrom && input.dateTo && input.dateTo < input.dateFrom) throw new DomainError("VALIDATION_FAILED", "The discount must end on or after its first day.");
  return {
    kind: "PROMOTION", name: input.name, scope: "PRODUCTS", productIds: target.productIds ?? [], productCategories: target.productCategories ?? [], adjustType: "PCT", adjustPct: input.pct,
    dateFrom: input.dateFrom || undefined, dateTo: input.dateTo || undefined, startTime: input.startTime || undefined, endTime: input.endTime || undefined,
    daysOfWeek: input.daysOfWeek, audience: input.audience, tiers: input.tiers,
  };
}

export async function addProductPromotion(actor: Actor, productId: string, raw: z.input<typeof productPromotionSchema>) {
  assertCan(actor, "shop.pricing");
  const input = productPromotionSchema.parse(raw);
  if (!(await prisma.product.findUnique({ where: { id: productId } }))) throw new DomainError("NOT_FOUND", "Product was not found.");
  return createRule(actor, discountRule(input, { productIds: [productId] }));
}

export const shopDiscountSchema = productPromotionSchema.extend({
  /** Empty = every shop product. */
  categories: z.array(z.enum(CATEGORIES)).default([]),
});

/** A discount on whole categories of the shop (or the whole shop). */
export async function addShopDiscount(actor: Actor, raw: z.input<typeof shopDiscountSchema>) {
  assertCan(actor, "shop.pricing");
  const input = shopDiscountSchema.parse(raw);
  return createRule(actor, discountRule(input, { productCategories: input.categories }));
}

/** End a shop discount now (the price book keeps it, ended). Only discounts on shop products. */
export async function endShopDiscount(actor: Actor, ruleId: string) {
  assertCan(actor, "shop.pricing");
  const r = await prisma.priceRule.findUnique({ where: { id: ruleId } });
  if (!r || r.scope !== "PRODUCTS" || r.kind !== "PROMOTION") throw new DomainError("NOT_FOUND", "Shop discount was not found.");
  return endRule(actor, ruleId);
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function discountView(r: PriceRule, inEffect: Set<string>) {
  const dates = [r.dateFrom ? `from ${fromDbDate(r.dateFrom)}` : "", r.dateTo ? `until ${fromDbDate(r.dateTo)}` : ""].filter(Boolean).join(" ");
  const days = r.daysOfWeek.length && r.daysOfWeek.length < 7 ? r.daysOfWeek.map((d) => DAY[d]).join(", ") : "";
  return {
    id: r.id, code: r.code, name: r.name, pct: r.adjustPct, flat: r.flatAmount, window: ruleWindow(r), when: [days, dates].filter(Boolean).join(" · "),
    categories: r.productCategories, productIds: r.productIds, audience: r.audience, tiers: r.tiers, status: r.status, inEffect: inEffect.has(r.id),
  };
}

/** Shop discounts that are on, waiting for approval or scheduled (not ended). */
async function openShopDiscounts() {
  const now = clock.now();
  const rules = await prisma.priceRule.findMany({
    where: { kind: "PROMOTION", scope: "PRODUCTS", status: { in: ["ACTIVE", "PENDING_APPROVAL"] }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { createdAt: "desc" },
  });
  const inEffect = new Set((await rulesInEffect(prisma, now, "PRODUCTS")).map((r) => r.id));
  return { rules, inEffect };
}

/** The products page: category-wide and shop-wide discounts (per-product ones are on each product's page). */
export async function listShopDiscounts(actor: Actor) {
  assertCan(actor, "shop.view");
  const { rules, inEffect } = await openShopDiscounts();
  const s = await getSettings();
  return {
    canEdit: can(actor, "shop.pricing"),
    staffLimitPct: s.max_staff_discount_pct,
    discounts: rules.filter((r) => !r.productIds.length).map((r) => discountView(r, inEffect)),
  };
}

// ───────── the edit page ─────────

export async function productDetail(actor: Actor, id: string) {
  assertCan(actor, "shop.view");
  const p = await prisma.product.findUnique({ where: { id }, include: { variants: { orderBy: { label: "asc" } } } });
  if (!p) throw new DomainError("NOT_FOUND", "Product was not found.");
  const now = clock.now();
  const [images, scheduled, open, s] = await Promise.all([
    prisma.productImage.findMany({ where: { productId: id }, orderBy: { sort: "asc" } }),
    prisma.priceChange.findMany({ where: { target: { in: p.variants.map((v) => `VARIANT:${v.id}`) }, cancelledAt: null, effectiveAt: { gt: now } }, orderBy: { effectiveAt: "asc" } }),
    openShopDiscounts(),
    getSettings(),
  ]);
  const applies = open.rules.filter((r) => (!r.productIds.length && !r.productCategories.length) || r.productIds.includes(id) || r.productCategories.includes(p.category));
  return {
    ...p,
    images,
    // D-79: shop staff set shop prices and discounts too.
    canEditPrices: can(actor, "shop.pricing"),
    canEdit: can(actor, "shop.stock"),
    staffLimitPct: s.max_staff_discount_pct,
    variants: p.variants.map((v) => ({ ...v, available: v.onHand - v.reserved, scheduled: scheduled.filter((c) => c.target === `VARIANT:${v.id}`).map((c) => ({ id: c.id, price: c.price, effectiveAt: c.effectiveAt })) })),
    promotions: applies.map((r) => ({ ...discountView(r, open.inEffect), own: r.productIds.includes(id) })),
  };
}
