// D-79: shop staff manage their own products end to end — shop prices through the price book and shop discounts
// (price-book promotions on shop products) within the shop-staff limit. Never courts, social play, plans or the bar menu.
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { quoteShop } from "@/server/services/pricing";
import { cancelPriceChange, changeRule, createRule, decideRule, endRule, setBasePrice } from "@/server/services/price-book";
import { addProductPromotion, addShopDiscount, addVariant, endShopDiscount, listShopDiscounts, productDetail } from "@/server/services/products";
import { checkout, counterSale, listCatalogue, updateVariant } from "@/server/services/shop";
import { updatePlan } from "@/server/services/plans";
import { updateMenuItem } from "@/server/services/bar";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { makeBar } from "../helpers/bar";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld(); // Monday 12 Oct 2026, 10:00 IST; shop staff limit 15%, manager 30%
});

const walkInPrice = async (variantId: string, price: number) =>
  (await quoteShop(prisma, { date: "2026-10-12", items: [{ variantId, qty: 1, name: "x", price, taxCategory: "GOODS_18", hsnSac: "9506" }] })).lines[0];

describe("D-79 shop staff set shop prices (price book, history, audit)", () => {
  it("a price now and a scheduled price: price_changes history, audit rows, the engine uses them", async () => {
    const r = await makeProduct(w, { name: "Staff Racket", price: 500000, onHand: 3 });
    const now = await setBasePrice(w.actors.SHOP_STAFF, { target: `VARIANT:${r.variantId}`, price: 450000, note: "Supplier price drop" });
    expect(now).toMatchObject({ target: `VARIANT:${r.variantId}`, price: 450000, createdBy: w.actors.SHOP_STAFF.userId });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: r.variantId } })).price).toBe(450000);
    expect(await prisma.auditLog.count({ where: { action: "price.change", entityId: now.id, actorId: w.actors.SHOP_STAFF.userId } })).toBe(1);
    expect((await walkInPrice(r.variantId, 500000)).unitPrice).toBe(450000);

    const later = await setBasePrice(w.actors.SHOP_STAFF, { target: `VARIANT:${r.variantId}`, price: 480000, effectiveAt: istToUtc("2026-10-15", "00:00").toISOString() });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: r.variantId } })).price).toBe(450000); // not yet
    expect((await productDetail(w.actors.SHOP_STAFF, r.productId)).variants[0].scheduled.map((s) => s.price)).toEqual([480000]);
    clock.set(istToUtc("2026-10-15", "09:00"));
    expect((await walkInPrice(r.variantId, 450000)).unitPrice).toBe(480000);
    clock.set(istToUtc("2026-10-12", "10:00"));
    await cancelPriceChange(w.actors.SHOP_STAFF, later.id); // withdraw a change that hasn't started
    expect(await prisma.auditLog.count({ where: { action: "price.change_cancelled", entityId: later.id } })).toBe(1);

    // The variant form (PATCH) and a new size/colour go the same way.
    await updateVariant(w.actors.SHOP_STAFF, r.variantId, { price: 470000, sku: "staff-rkt-1", hsnSac: "95065100" });
    expect(await prisma.priceChange.count({ where: { target: `VARIANT:${r.variantId}`, cancelledAt: null } })).toBe(2);
    expect(await prisma.productVariant.findUniqueOrThrow({ where: { id: r.variantId } })).toMatchObject({ price: 470000, sku: "STAFF-RKT-1", hsnSac: "95065100" });
    const v2 = await addVariant(w.actors.SHOP_STAFF, r.productId, { sku: "STAFF-RKT-2", label: "Grip 3", price: 470000, hsnSac: "9506" });
    expect(v2.price).toBe(470000);
    await expect(updateVariant(w.actors.SHOP_STAFF, v2.id, { sku: "STAFF-RKT-1" })).rejects.toThrow(/already in use/);
    expect((await productDetail(w.actors.SHOP_STAFF, r.productId)).canEditPrices).toBe(true);
    await expectIntegrity();
  });

  it("shop staff can't price a court, social play, a plan or a bar menu item, nor touch those rules (FORBIDDEN)", async () => {
    const lime = (await makeBar(w)).lime;
    const ss = w.actors.SHOP_STAFF;
    for (const target of ["COURT_FEE:WALK_IN:TENNIS", "COURT_FEE:GOLD:TENNIS", "SOCIAL_FEE:SILVER", `MENU:${lime.id}`]) {
      await expect(setBasePrice(ss, { target, price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const plan = await prisma.plan.findFirstOrThrow({ where: { code: "GOLD" } });
    await expect(updatePlan(ss, plan.id, { socialFee: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateMenuItem(ss, lime.id, { price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const scope of ["COURTS", "SOCIAL", "MENU"] as const) {
      await expect(createRule(ss, { kind: "PROMOTION", name: "Sneaky", scope, adjustType: "PCT", adjustPct: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(createRule(ss, { kind: "BAND", name: "Peak", scope: "COURTS", daysOfWeek: [1], startTime: "18:00", endTime: "20:00", adjustType: "PCT", adjustPct: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The Owner's court rule can't be ended or "changed" into a shop discount by shop staff (v4 RN-3: the Owner prices courts).
    const band = await createRule(w.actors.OWNER, { kind: "BAND", name: "Peak", scope: "COURTS", daysOfWeek: [1], startTime: "18:00", endTime: "20:00", adjustType: "PCT", adjustPct: 10 });
    await expect(endRule(ss, band.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(endShopDiscount(ss, band.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(changeRule(ss, band.id, { kind: "PROMOTION", name: "Swap", scope: "PRODUCTS", adjustType: "PCT", adjustPct: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.priceRule.findUniqueOrThrow({ where: { id: band.id } })).toMatchObject({ status: "ACTIVE", effectiveTo: null });
    expect(await prisma.priceRule.count()).toBe(1);
    expect(await prisma.priceChange.count({ where: { createdBy: ss.userId } })).toBe(0);
  });
});

describe("D-79 shop discounts by shop staff", () => {
  it("within the limit: a product discount and a category discount start at once (audited); ending one is audited", async () => {
    const bag = await makeProduct(w, { name: "Kit Bag", category: "ACCESSORIES", price: 200000, onHand: 4 });
    const ball = await makeProduct(w, { name: "Ball Can", category: "BALLS", price: 50000, onHand: 9 });
    const own = await addProductPromotion(w.actors.SHOP_STAFF, bag.productId, { name: "Bag deal", pct: 15 });
    expect([own.status, own.approvalNeeded, own.scope, own.productIds]).toEqual(["ACTIVE", null, "PRODUCTS", [bag.productId]]);
    const cat = await addShopDiscount(w.actors.SHOP_STAFF, { name: "Ball week", pct: 10, categories: ["BALLS"], dateFrom: "2026-10-12", dateTo: "2026-10-18" });
    expect([cat.status, cat.productCategories]).toEqual(["ACTIVE", ["BALLS"]]);
    expect(await prisma.auditLog.count({ where: { action: "price_rule.create", actorId: w.actors.SHOP_STAFF.userId } })).toBe(2);
    expect((await walkInPrice(bag.variantId, 200000))).toMatchObject({ discountAmount: 30000, netAmount: 170000 });
    expect((await walkInPrice(ball.variantId, 50000))).toMatchObject({ discountAmount: 5000, explanation: "Walk-in · Ball week −10%" });
    const list = await listShopDiscounts(w.actors.SHOP_STAFF);
    expect([list.canEdit, list.staffLimitPct, list.discounts.map((d) => d.name)]).toEqual([true, 15, ["Ball week"]]); // per-product ones live on the product
    expect((await productDetail(w.actors.SHOP_STAFF, bag.productId)).promotions.map((p) => p.name)).toEqual(["Bag deal"]);

    await endShopDiscount(w.actors.SHOP_STAFF, cat.id);
    expect((await prisma.priceRule.findUniqueOrThrow({ where: { id: cat.id } })).status).toBe("ENDED");
    expect(await prisma.auditLog.count({ where: { action: "price_rule.end", entityId: cat.id } })).toBe(1);
    expect((await walkInPrice(ball.variantId, 50000)).discountAmount).toBe(0);
    expect((await listShopDiscounts(w.actors.SHOP_STAFF)).discounts).toEqual([]);
  });

  it("a time band discount applies only inside its window", async () => {
    const grip = await makeProduct(w, { name: "Overgrip", category: "ACCESSORIES", price: 30000, onHand: 9 });
    await addShopDiscount(w.actors.SHOP_STAFF, { name: "Morning", pct: 10, categories: ["ACCESSORIES"], startTime: "09:00", endTime: "11:00", daysOfWeek: [1, 2, 3, 4, 5] });
    expect((await walkInPrice(grip.variantId, 30000)).discountAmount).toBe(3000); // Monday 10:00
    clock.set(istToUtc("2026-10-12", "12:00"));
    expect((await walkInPrice(grip.variantId, 30000)).discountAmount).toBe(0);
  });

  // v4 RN-3 (was: "a manager approves within theirs"): above the shop-staff limit a discount waits for the Owner only.
  it("above the limit it waits for the Owner's approval (not applied); the Manager and shop staff can't approve", async () => {
    const shoe = await makeProduct(w, { name: "Court Shoe", category: "SHOES", price: 400000, onHand: 2 });
    const big = await addProductPromotion(w.actors.SHOP_STAFF, shoe.productId, { name: "Shoe blowout", pct: 25 });
    expect([big.status, big.approvalNeeded]).toEqual(["PENDING_APPROVAL", "above the 15% limit for shop staff"]);
    const shopWide = await addShopDiscount(w.actors.SHOP_STAFF, { name: "Everything", pct: 40 });
    expect(shopWide.status).toBe("PENDING_APPROVAL");
    expect((await walkInPrice(shoe.variantId, 400000)).discountAmount).toBe(0);
    await expect(decideRule(w.actors.SHOP_STAFF, big.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRule(w.actors.MANAGER, shopWide.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRule(w.actors.MANAGER, big.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideRule(w.actors.OWNER, big.id, "APPROVE");
    expect((await walkInPrice(shoe.variantId, 400000)).discountAmount).toBe(100000);
    await expect(addShopDiscount(w.actors.SHOP_STAFF, { name: "Bad", pct: 10, dateFrom: "2026-10-20", dateTo: "2026-10-19" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("checkout, the counter and the public catalogue use the discounted price (one engine)", async () => {
    const racket = await makeProduct(w, { name: "Promo Racket", category: "RACKETS", price: 1000000, onHand: 5 });
    await setBasePrice(w.actors.SHOP_STAFF, { target: `VARIANT:${racket.variantId}`, price: 900000 });
    await addShopDiscount(w.actors.SHOP_STAFF, { name: "Racket week", pct: 15, categories: ["RACKETS"] });
    const cat = (await listCatalogue()).find((p) => p.id === racket.productId)!;
    expect(cat.variants[0]).toMatchObject({ price: 900000, offerPrice: 765000, offer: "Racket week −15%" });
    const m = await makeMember(w, { name: "Silver Sia", plan: "SILVER" }); // plan 10% < promo 15%
    const order = await checkout(m.actor, { items: [{ variantId: racket.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    expect(order.total).toBe(765000);
    const line = await prisma.billLine.findFirstOrThrow({ where: { billId: order.billId, variantId: racket.variantId } });
    expect([line.unitPrice, line.discountAmount]).toEqual([900000, 135000]);
    const sale = await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    expect(sale.total).toBe(765000);
    const other = (await listCatalogue()).flatMap((p) => p.variants).filter((v) => v.id !== racket.variantId);
    expect(other.every((v) => v.offerPrice === null)).toBe(true);
    await expectIntegrity();
  });

  it("the front desk can't change shop prices or discounts", async () => {
    const r = await makeProduct(w, { name: "Desk Grip", category: "ACCESSORIES", price: 20000, onHand: 3 });
    const promo = await addProductPromotion(w.actors.SHOP_STAFF, r.productId, { name: "Grip deal", pct: 10 });
    const fd = w.actors.FRONT_DESK;
    await expect(setBasePrice(fd, { target: `VARIANT:${r.variantId}`, price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateVariant(fd, r.variantId, { price: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addVariant(fd, r.productId, { sku: "DESK-2", label: "XL", price: 1, hsnSac: "9506" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addProductPromotion(fd, r.productId, { name: "Desk deal", pct: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addShopDiscount(fd, { name: "Desk sale", pct: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createRule(fd, { kind: "PROMOTION", name: "Desk sale", scope: "PRODUCTS", adjustType: "PCT", adjustPct: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(endShopDiscount(fd, promo.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(endRule(fd, promo.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const view = await productDetail(fd, r.productId);
    expect([view.canEditPrices, view.canEdit]).toEqual([false, false]);
    expect((await listShopDiscounts(fd)).canEdit).toBe(false);
    expect(await prisma.priceChange.count({ where: { createdBy: fd.userId } })).toBe(0);
    expect((await prisma.priceRule.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe("ACTIVE");
  });
});
