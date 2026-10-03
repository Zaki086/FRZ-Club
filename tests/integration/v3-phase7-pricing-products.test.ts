// v3 phase 7: dynamic pricing (§9.2 PR-10…PR-15) and product management (§9.3).
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { quoteBar, quoteCourt, quoteShop } from "@/server/services/pricing";
import { changeRule, createRule, decideRule, publicPriceNotes, setBasePrice, simulatePrice } from "@/server/services/price-book";
import { addProductPhoto, addProductPromotion, archiveProduct, productDetail, removeProductPhoto, reorderProductPhotos, restoreProduct, updateProductDetails } from "@/server/services/products";
import { checkout, updateVariant } from "@/server/services/shop";
import { listView } from "@/server/services/filters";
import { uploadDir } from "@/server/services/uploads";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { makeBar } from "../helpers/bar";
import { book, guest } from "../helpers/booking";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Monday 12 Oct 2026, 10:00 IST
});

const courtQuote = (time: string, opts: { date?: string; memberId?: string; court?: string } = {}) =>
  quoteCourt(prisma, {
    sport: "TENNIS", date: opts.date ?? "2026-10-12", courtName: "Court 1", timeLabel: time, courtId: w.courts[opts.court ?? "Court 1"].id,
    startMinute: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), players: [opts.memberId ? { memberId: opts.memberId, name: "M" } : { guestId: "g", name: "Guest" }],
  });
const peak = { kind: "BAND" as const, name: "Peak", scope: "COURTS" as const, sports: ["TENNIS" as const], daysOfWeek: [1, 2, 3, 4, 5], startTime: "18:00", endTime: "21:00", adjustType: "PCT" as const, adjustPct: 20 };

describe("v3 §9.2 — the price book (PR-10…PR-15)", () => {
  it("existing prices are unchanged with no rules (PR-15), and come from the price book", async () => {
    expect((await courtQuote("18:00")).players[0]).toMatchObject({ unitPrice: 40000, netAmount: 40000, explanation: "Walk-in rate · ₹400 per player per hour" });
    expect(await prisma.priceRule.count()).toBe(0);
    expect(await publicPriceNotes()).toEqual([]);
  });

  it("PR-10: a time band adjusts the base price inside its window only; overlapping bands are refused", async () => {
    const r = await createRule(w.actors.OWNER, peak);
    expect(r.status).toBe("ACTIVE");
    const p18 = (await courtQuote("18:00")).players[0];
    expect([p18.unitPrice, p18.explanation]).toEqual([48000, "Walk-in ₹400 · Peak 18:00–21:00 +20%"]);
    expect((await courtQuote("17:00")).players[0].unitPrice).toBe(40000);
    expect((await courtQuote("18:00", { date: "2026-10-17" })).players[0].unitPrice).toBe(40000); // Saturday
    await expect(createRule(w.actors.OWNER, { ...peak, name: "Evening", startTime: "20:00", endTime: "22:00", daysOfWeek: [5] })).rejects.toMatchObject({ code: "PRICE_BAND_OVERLAP" });
    expect((await createRule(w.actors.OWNER, { ...peak, name: "Padel peak", sports: ["PADEL"] })).status).toBe("ACTIVE"); // other sport
    expect((await publicPriceNotes()).map((n) => n.text)).toContain("Tennis: Peak +20% · weekdays 18:00–21:00");
  });

  it("PR-10: a special date overrides the band (fixed price per tier)", async () => {
    await createRule(w.actors.OWNER, peak);
    await createRule(w.actors.OWNER, { kind: "SPECIAL_DATE", name: "Diwali", scope: "COURTS", dateFrom: "2026-10-12", adjustType: "FIXED", fixedPrices: { WALK_IN: 30000 } });
    const p = (await courtQuote("18:00")).players[0];
    expect([p.unitPrice, p.explanation]).toEqual([30000, "Walk-in ₹400 · Diwali ₹300"]);
    expect((await courtQuote("18:00", { date: "2026-10-13" })).players[0].unitPrice).toBe(48000); // the band again next day
  });

  it("PR-10: the customer gets the single best of plan discount and promotions — never stacked", async () => {
    const m = await makeMember(w, { name: "Silver Sia", plan: "SILVER" }); // 10% shop discount
    const r = await makeProduct(w, { name: "Pro Racket", price: 1000000, onHand: 5 });
    const shop = () => quoteShop(prisma, { memberId: m.memberId, date: "2026-10-12", items: [{ variantId: r.variantId, qty: 1, name: "Pro Racket", price: 1000000, taxCategory: "GOODS_5", hsnSac: "9506" }] });
    expect((await shop()).lines[0]).toMatchObject({ discountAmount: 100000, explanation: "Silver member · 10% shop discount" });
    await createRule(w.actors.OWNER, { kind: "PROMOTION", name: "Racket week", scope: "PRODUCTS", productCategories: ["RACKETS"], adjustType: "PCT", adjustPct: 15 });
    expect((await shop()).lines[0]).toMatchObject({ discountAmount: 150000, netAmount: 850000, explanation: "Silver member · Racket week −15% (better than plan −10%)" });
    await createRule(w.actors.OWNER, { kind: "PROMOTION", name: "Small promo", scope: "PRODUCTS", adjustType: "PCT", adjustPct: 5 });
    expect((await shop()).lines[0].discountAmount).toBe(150000); // still the single best, not 15 + 10 + 5
    // Bar happy hour 17:00–19:00 vs the plan's 10% bar discount.
    const item = (await makeBar(w)).lime;
    await createRule(w.actors.OWNER, { kind: "PROMOTION", name: "Happy hour", scope: "MENU", startTime: "17:00", endTime: "19:00", adjustType: "PCT", adjustPct: 25 });
    const bar = (at: string) => quoteBar(prisma, { memberId: m.memberId, date: "2026-10-12", at: istToUtc("2026-10-12", at), items: [{ menuItemId: item.id, qty: 2, name: item.name, price: item.price, taxCategory: item.taxCategory, hsnSac: item.hsnSac }] });
    expect((await bar("17:30")).lines[0].explanation).toBe("Silver member · Happy hour 17:00–19:00 −25% (better than plan −10%)");
    expect((await bar("20:00")).lines[0].discountPct).toBe(10);
  });

  // v4 RN-3 (was: "above the manager limit a promotion waits for the Owner"): the Manager no longer prices or approves.
  it("PR-11 / RN-3: only the Owner prices; a shop-staff discount above their limit or a flat ₹ promotion waits for the Owner; guardrails are Owner-only", async () => {
    const r = await makeProduct(w, { name: "Grip", category: "ACCESSORIES", price: 50000, onHand: 5 });
    const promo = { kind: "PROMOTION" as const, name: "Clearance", scope: "PRODUCTS" as const, productIds: [r.productId], adjustType: "PCT" as const, adjustPct: 40 };
    await expect(createRule(w.actors.MANAGER, promo)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await createRule(w.actors.SHOP_STAFF, promo);
    expect([p.status, p.approvalNeeded]).toEqual(["PENDING_APPROVAL", "above the 15% limit for shop staff"]);
    const q = () => quoteShop(prisma, { date: "2026-10-12", items: [{ variantId: r.variantId, qty: 1, name: "Grip", price: 50000, taxCategory: "GOODS_18", hsnSac: "9506" }] });
    expect((await q()).lines[0].discountAmount).toBe(0); // not in effect until approved
    await expect(decideRule(w.actors.MANAGER, p.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRule(w.actors.SHOP_STAFF, p.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideRule(w.actors.OWNER, p.id, "APPROVE");
    expect((await q()).lines[0].discountAmount).toBe(20000);
    expect((await createRule(w.actors.SHOP_STAFF, { ...promo, name: "Flat", adjustType: "FLAT", adjustPct: undefined, flatAmount: 5000 })).status).toBe("PENDING_APPROVAL");
    expect((await createRule(w.actors.OWNER, { ...promo, name: "Owner flat", adjustType: "FLAT", adjustPct: undefined, flatAmount: 5000 })).status).toBe("ACTIVE");
    await expect(createRule(w.actors.FRONT_DESK, promo)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { updateSetting } = await import("@/server/services/settings");
    await expect(updateSetting(w.actors.MANAGER, "max_manager_discount_pct", 50)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("PR-12: a price change can be scheduled; it starts on time; existing bills never change; rules are versioned", async () => {
    const b = await book(w, { time: "18:00", players: [guest("Early Esha")] });
    await setBasePrice(w.actors.OWNER, { target: "COURT_FEE:WALK_IN:TENNIS", price: 50000, effectiveAt: istToUtc("2026-10-13", "00:00").toISOString() });
    expect((await courtQuote("18:00", { date: "2026-10-14" })).players[0].unitPrice).toBe(40000); // not yet
    clock.set(istToUtc("2026-10-13", "00:01"));
    expect((await courtQuote("18:00", { date: "2026-10-14" })).players[0].unitPrice).toBe(50000);
    const lines = await prisma.billLine.findMany({ where: { billId: b.billId } });
    expect(lines.map((l) => l.unitPrice)).toEqual([40000]); // the old bill keeps its snapshot
    await expect(setBasePrice(w.actors.FRONT_DESK, { target: "COURT_FEE:WALK_IN:TENNIS", price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r1 = await createRule(w.actors.OWNER, peak);
    const r2 = await changeRule(w.actors.OWNER, r1.id, { ...peak, adjustPct: 25 });
    const old = await prisma.priceRule.findUniqueOrThrow({ where: { id: r1.id } });
    expect([old.effectiveTo?.getTime(), r2.replacesId]).toEqual([clock.now().getTime(), r1.id]);
    expect((await courtQuote("18:00", { date: "2026-10-14" })).players[0].unitPrice).toBe(62500);
    expect(await prisma.auditLog.count({ where: { action: { in: ["price.change", "price_rule.create", "price_rule.replaced"] } } })).toBe(4);
    await expectIntegrity();
  });

  it("PR-13: the simulator prices with the real engine and explains it", async () => {
    await createRule(w.actors.OWNER, peak);
    const s = await simulatePrice(w.actors.OWNER, { offering: "COURT", tier: "WALK_IN", date: "2026-10-12", time: "19:00", courtId: w.courts["Court 1"].id });
    expect(s).toMatchObject({ total: 48000, lines: [{ explanation: "Walk-in ₹400 · Peak 18:00–21:00 +20%" }] });
    await expect(simulatePrice(w.actors.FRONT_DESK, { offering: "COURT", tier: "WALK_IN", date: "2026-10-12", time: "19:00", courtId: w.courts["Court 1"].id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // v4 RN-3: the price book (and its simulator) is the Owner's alone.
    await expect(simulatePrice(w.actors.MANAGER, { offering: "COURT", tier: "WALK_IN", date: "2026-10-12", time: "19:00", courtId: w.courts["Court 1"].id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the booking flow uses the band at confirm (a regular booking at peak costs more)", async () => {
    await createRule(w.actors.OWNER, peak);
    const b = await book(w, { time: "19:00", players: [guest("Peak Pooja")] });
    expect(b.total).toBe(48000);
    expect(b.players[0].explanation).toBe("Walk-in ₹400 · Peak 18:00–21:00 +20%");
  });
});

async function png(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 60 } } }).png().toBuffer();
}

describe("v3 §9.3 — product management", () => {
  it("up to 5 photos, resized to 1200 px with a 400 px thumbnail; the first is the cover; reorder and remove", async () => {
    const r = await makeProduct(w, { name: "Photo Racket", price: 500000 });
    const a = await addProductPhoto(w.actors.SHOP_STAFF, r.productId, await png(2400, 1600));
    const meta = async (url: string) => sharp(await readFile(path.join(uploadDir(), "product", url.split("/").pop()!))).metadata();
    expect([(await meta(a.url)).width, (await meta(a.url)).height, (await meta(a.thumbUrl)).width]).toEqual([1200, 800, 400]);
    const small = await addProductPhoto(w.actors.SHOP_STAFF, r.productId, await png(300, 300));
    expect((await meta(small.url)).width).toBe(300); // never enlarged
    for (let i = 0; i < 3; i++) await addProductPhoto(w.actors.SHOP_STAFF, r.productId, await png(500, 500));
    await expect(addProductPhoto(w.actors.SHOP_STAFF, r.productId, await png(500, 500))).rejects.toThrow(/at most 5 photos/);
    await expect(addProductPhoto(w.actors.SHOP_STAFF, r.productId, Buffer.from("not an image"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productId } })).imageUrl).toBe(a.url);
    const ids = (await productDetail(w.actors.SHOP_STAFF, r.productId)).images.map((i) => i.id);
    await reorderProductPhotos(w.actors.SHOP_STAFF, r.productId, [...ids.slice(1), ids[0]]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productId } })).imageUrl).toBe(small.url);
    await removeProductPhoto(w.actors.SHOP_STAFF, r.productId, small.id);
    expect((await productDetail(w.actors.SHOP_STAFF, r.productId)).images).toHaveLength(4);
    await expect(addProductPhoto(w.actors.FRONT_DESK, r.productId, await png(500, 500))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("details (description up to 2,000 characters), price through the price book (not the front desk), and stock never edited here", async () => {
    const r = await makeProduct(w, { name: "Detail Shoe", category: "SHOES", price: 400000, onHand: 4 });
    await updateProductDetails(w.actors.SHOP_STAFF, r.productId, { description: "Line one\nLine two", brand: "Acme" });
    await expect(updateProductDetails(w.actors.SHOP_STAFF, r.productId, { description: "x".repeat(2001) })).rejects.toThrow(/2,000/);
    // D-79: shop staff may now set shop prices (tests/integration/v3-shop-staff-pricing.test.ts); the front desk still can't.
    await expect(updateVariant(w.actors.FRONT_DESK, r.variantId, { price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // v4 RN-3: shop prices are the Owner's and the shop staff's (no longer the Manager's).
    await expect(updateVariant(w.actors.MANAGER, r.variantId, { price: 450000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateVariant(w.actors.OWNER, r.variantId, { price: 450000 });
    expect(await prisma.priceChange.findFirstOrThrow({ where: { target: `VARIANT:${r.variantId}` } })).toMatchObject({ price: 450000 });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: r.variantId } })).onHand).toBe(4);
  });

  it("archive instead of delete; blocked while online orders hold stock (PRODUCT_HAS_RESERVATIONS); restore", async () => {
    const r = await makeProduct(w, { name: "Held Balls", category: "BALLS", price: 60000, onHand: 3 });
    const m = await makeMember(w, { name: "Online Olga", plan: "SILVER" });
    await checkout(m.actor, { items: [{ variantId: r.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    await expect(archiveProduct(w.actors.SHOP_STAFF, r.productId)).rejects.toMatchObject({ code: "PRODUCT_HAS_RESERVATIONS" });
    const free = await makeProduct(w, { name: "Free Balls", category: "BALLS", price: 60000, onHand: 3 });
    await archiveProduct(w.actors.SHOP_STAFF, free.productId);
    let list = await listView(w.actors.SHOP_STAFF, "products", { status: "ARCHIVED" });
    expect(list.rows.map((x) => x.name)).toEqual(["Free Balls"]);
    await restoreProduct(w.actors.SHOP_STAFF, free.productId);
    list = await listView(w.actors.SHOP_STAFF, "products", { status: "ARCHIVED" });
    expect(list.total).toBe(0);
    await expect(prisma.product.delete({ where: { id: free.productId } })).rejects.toThrow();
  });

  it("inline product promotion: shop staff up to 15%, above that it waits for approval; the list shows it", async () => {
    const r = await makeProduct(w, { name: "Promo Bag", category: "ACCESSORIES", price: 200000, onHand: 2 });
    const ok = await addProductPromotion(w.actors.SHOP_STAFF, r.productId, { name: "Bag deal", pct: 15 });
    expect(ok.status).toBe("ACTIVE");
    const big = await addProductPromotion(w.actors.SHOP_STAFF, r.productId, { name: "Bag blowout", pct: 20 });
    expect([big.status, big.approvalNeeded]).toEqual(["PENDING_APPROVAL", "above the 15% limit for shop staff"]);
    // v4 RN-3: shop-staff discounts above their limit wait for the Owner (no manager approvals).
    await expect(decideRule(w.actors.MANAGER, big.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideRule(w.actors.OWNER, big.id, "APPROVE");
    expect((await prisma.priceRule.findUniqueOrThrow({ where: { id: big.id } })).status).toBe("ACTIVE");
    const list = await listView(w.actors.SHOP_STAFF, "products", { promo: "yes" });
    expect(list.rows.map((x) => x.name)).toContain("Promo Bag");
    expect((await productDetail(w.actors.SHOP_STAFF, r.productId)).promotions.map((p) => p.name).sort()).toEqual(["Bag blowout", "Bag deal"]);
  });
});
