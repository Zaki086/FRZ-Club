// v6 §4 (SHOP) + JR-1: SM-1 café menu for shop staff, SM-2 Add product, WI-1…WI-6 walk-in counter sales (anonymous,
// with a phone, member-phone prompt, WALK_IN pricing, receipt code/QR refunds, reports), TL-1…TL-4 tills by area,
// JR-1 no split payments on a Junior's / under-18's bill.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { canOpenPage } from "@/server/rbac/page-access";
import { navFor } from "@/app/(staff)/app/_nav";
import { addLines, listMenu, openTab, settleTab } from "@/server/services/bar";
import { addMenuItem, createMenuCategory, editMenuItem, memberMenuView } from "@/server/services/menu";
import { counterSale, createProduct, findSaleByReceipt, listCatalogue, quoteCart, walkInPhoneMembers } from "@/server/services/shop";
import { addProductPromotion } from "@/server/services/products";
import { receiveStock } from "@/server/services/inventory";
import { getBill, recordCounterPayment } from "@/server/services/payments";
import { findCollectableRefunds, payOutRefund } from "@/server/services/refunds";
import { receiptToken } from "@/server/services/receipt-qr";
import { closeDrawer, ensureTill, listTills, mismatchedOpenSessions, myDrawer, openDrawer } from "@/server/services/drawers";
import { listView } from "@/server/services/filters";
import { dashboard } from "@/server/services/reports";
import { clock } from "@/lib/clock";
import { makeWorld, utr, CARD_PROOF, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { approvedRefund } from "../helpers/refunds";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const ss = () => w.actors.SHOP_STAFF;

describe("v6 §4.1 — café menu and products for shop staff", () => {
  it("SM-1: shop staff see “Café menu”, open the menu builder pages and create a menu item members and the bar grid see", async () => {
    const nav = navFor(ss()).flatMap((g) => g.items);
    expect(nav.find((i) => i.label === "Café menu")?.href).toBe("/app/bar/menu");
    for (const p of ["/app/bar/menu", "/app/bar/menu/preview", "/print/menu", "/print/menu/tables"]) expect(canOpenPage("SHOP_STAFF", p)).toBe(true);
    const cat = await createMenuCategory(ss(), { name: "Café specials" });
    const item = await addMenuItem(ss(), { name: "Cold coffee", categoryId: cat.id, price: 15000, kind: "DRINK" });
    await editMenuItem(ss(), item.id, { price: 16000 }); // MN-1 base price (price book, audited)
    expect((await prisma.priceChange.findMany({ where: { target: `MENU:${item.id}` } })).map((r) => [r.price, r.createdBy])).toContainEqual([16000, ss().userId]);
    expect((await prisma.auditLog.findMany({ where: { entityId: item.id, action: "menu.price" } })).length).toBe(1);
    expect((await listMenu()).find((m) => m.id === item.id)).toBeTruthy();
    const neha = await makeMember(w, { name: "Neha Menu", plan: "SILVER" });
    const view = await memberMenuView(prisma, { memberId: neha.memberId, hideAlcohol: false });
    expect(view.flatMap((c) => c.items).find((i) => i.id === item.id)).toBeTruthy();
    await expectIntegrity();
  });

  it("SM-2: shop staff add a product (name, description, variants, price) and a discount within the guardrail; the public shop shows it", async () => {
    const p = await createProduct(ss(), {
      name: "Club cap", brand: "Champions", category: "APPAREL", description: "Breathable cotton cap",
      variants: [{ sku: "CAP-RED", label: "Red", price: 50000, hsnSac: "6505" }, { sku: "CAP-BLU", label: "Blue", price: 50000, hsnSac: "6505" }],
    });
    await receiveStock(ss(), { variantId: p.variants[0].id, qty: 5, unitCost: 30000, supplier: "Cap Co" });
    await addProductPromotion(ss(), p.id, { name: "Cap week", pct: 10 }); // within max_staff_discount_pct (15 %)
    const pub = (await listCatalogue()).find((x) => x.id === p.id)!;
    expect(pub).toMatchObject({ name: "Club cap", description: "Breathable cotton cap" });
    expect(pub.variants.map((v) => [v.label, v.price, v.offerPrice])).toEqual(expect.arrayContaining([["Red", 50000, 45000], ["Blue", 50000, 45000]]));
    await expectIntegrity();
  });
});

describe("v6 §4.2 — walk-in customers at the counter", () => {
  it("WI-1/WI-4/WI-5: a walk-in sale without a phone is anonymous (customer kind WALK_IN), paid in cash into the shop drawer", async () => {
    const grip = await makeProduct(w, { name: "Overgrip", category: "ACCESSORIES", price: 25000, onHand: 10 });
    const r = await counterSale(ss(), { walkIn: true, items: [{ variantId: grip.variantId, qty: 2 }], payments: [{ method: "CASH" }] });
    expect(r).toMatchObject({ total: 50000, tier: "WALK_IN", customerKind: "WALK_IN", walkIn: true, billStatus: "PAID" });
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId }, include: { payments: true } });
    expect([bill.memberId, bill.guestId, bill.customerName, bill.customerKind]).toEqual([null, null, "Walk-in customer", "WALK_IN"]);
    const pay = bill.payments[0];
    const session = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: pay.drawerSessionId! } });
    expect((await prisma.cashDrawer.findUniqueOrThrow({ where: { id: session.drawerId! } })).location).toBe("SHOP");
    expect(await prisma.drawerMovement.count({ where: { paymentId: pay.id, type: "CASH_SALE" } })).toBe(1);
    // A walk-in sale never carries a member.
    const m = await makeMember(w, { name: "Mixed Up", plan: "GOLD" });
    await expect(counterSale(ss(), { walkIn: true, memberId: m.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: [{ method: "CASH" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expectIntegrity();
  });

  it("WI-4: with a phone the walk-in is linked to (or becomes) a guest — the same guest the next time", async () => {
    const balls = await makeProduct(w, { name: "Ball can", category: "BALLS", price: 40000, onHand: 10 });
    const a = await counterSale(ss(), { walkIn: true, customerName: "Ravi Walk", customerPhone: "+91 98110 22334", items: [{ variantId: balls.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const b = await counterSale(ss(), { walkIn: true, customerName: "Ravi W", customerPhone: "9811022334", items: [{ variantId: balls.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const [ba, bb] = await Promise.all([a, b].map((x) => prisma.bill.findUniqueOrThrow({ where: { id: x.billId } })));
    expect(ba.guestId).toBeTruthy();
    expect(bb.guestId).toBe(ba.guestId);
    expect([ba.customerKind, ba.tier]).toEqual(["GUEST", "WALK_IN"]);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: ba.guestId! } })).phone).toBe("9811022334");
    await expect(counterSale(ss(), { walkIn: true, customerPhone: "12345", items: [{ variantId: balls.variantId, qty: 1 }], payments: [{ method: "CASH" }] })).rejects.toMatchObject({ name: "ZodError" }); // v5 CV-1 (422 at the API)
    await expectIntegrity();
  });

  it("WI-2/WI-3: a member's phone is pointed out (use member pricing?) but a walk-in sale stays at WALK_IN prices", async () => {
    const racket = await makeProduct(w, { name: "Pro racket", price: 1000000, onHand: 5 });
    const gold = await makeMember(w, { name: "Gita Gold", plan: "GOLD" });
    const prompt = await walkInPhoneMembers(ss(), gold.member.phone);
    expect(prompt.members.map((m) => [m.id, m.name, m.memberCode])).toEqual([[gold.memberId, "Gita Gold", gold.member.memberCode]]);
    expect(prompt.prompt).toEqual([`This number belongs to Gita Gold (${gold.member.memberCode}) — use member pricing?`]);
    expect((await walkInPhoneMembers(ss(), "9811099999")).members).toEqual([]);
    await expect(walkInPhoneMembers(w.actors.KITCHEN, gold.member.phone)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Never silent: the walk-in with Gita's number pays the walk-in price.
    const walk = await counterSale(ss(), { walkIn: true, customerPhone: gold.member.phone, items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    expect([walk.tier, walk.discountTotal, walk.total]).toEqual(["WALK_IN", 0, 1000000]);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: walk.billId } })).memberId).toBeNull();
    // One tap switches to the member: the plan discount applies.
    const member = await counterSale(ss(), { memberId: gold.memberId, items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "UPI", reference: utr() }] });
    expect(member.tier).toBe("GOLD");
    expect(member.discountTotal).toBeGreaterThan(0);
    expect((await quoteCart(ss(), { items: [{ variantId: racket.variantId, qty: 1 }] })).tier).toBe("WALK_IN");
    await expectIntegrity();
  });

  it("WI-5: an anonymous walk-in sale is found by its receipt code or receipt QR; its refund is paid out against the receipt", async () => {
    const shoes = await makeProduct(w, { name: "Court shoes", category: "SHOES", price: 300000, onHand: 3 });
    const sale = await counterSale(ss(), { walkIn: true, items: [{ variantId: shoes.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const qr = receiptToken(sale.billId);
    expect(await findSaleByReceipt(ss(), sale.code.toLowerCase())).toMatchObject({ via: "RECEIPT_CODE", saleId: sale.saleId, customerKind: "WALK_IN" });
    expect(await findSaleByReceipt(ss(), qr)).toMatchObject({ via: "RECEIPT_QR", code: sale.code });
    await expect(findSaleByReceipt(ss(), `${qr.slice(0, -2)}xx`)).rejects.toMatchObject({ code: "INVALID_REFUND_QR" });
    const ref = await approvedRefund(w, sale.billId, 300000, { by: ss() });
    expect(ref.pending).toBe(300000);
    const found = await findCollectableRefunds(ss(), qr);
    expect(found.via).toBe("RECEIPT_QR");
    expect(found.refunds.map((r) => [r.id, r.guest])).toEqual([[ref.id, { needsPhone: false, needsCode: true, codeLabel: "receipt code", walkIn: true }]]);
    expect((await findCollectableRefunds(ss(), sale.code)).refunds.map((r) => r.id)).toEqual([ref.id]);
    // Without the receipt (wrong code) nothing is paid out.
    await expect(payOutRefund(ss(), ref.id, { method: "CASH", identityChecked: true, originalCode: "CS-999999" })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED" });
    await expect(payOutRefund(ss(), ref.id, { method: "CASH", identityChecked: true, receiptToken: receiptToken("someotherbill") })).rejects.toMatchObject({ code: "IDENTITY_NOT_CHECKED" });
    const paid = await payOutRefund(ss(), ref.id, { method: "CASH", identityChecked: true, via: "RECEIPT_QR", receiptToken: qr });
    expect(paid.status).toBe("COMPLETED");
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: ref.id } })).identityMethod).toBe("RECEIPT_QR");
    // By the typed receipt code: RECEIPT_CODE.
    const sale2 = await counterSale(ss(), { walkIn: true, items: [{ variantId: shoes.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const ref2 = await approvedRefund(w, sale2.billId, 100000, { by: ss() });
    await payOutRefund(ss(), ref2.id, { method: "CASH", identityChecked: true, originalCode: sale2.code });
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: ref2.id } })).identityMethod).toBe("RECEIPT_CODE");
    await expectIntegrity();
  });

  it("WI-6: walk-in sales are Shop revenue and filter as “Walk-in” on Counter Sales", async () => {
    const grip = await makeProduct(w, { name: "Grip", category: "ACCESSORIES", price: 20000, onHand: 20 });
    const m = await makeMember(w, { name: "Sana Silver", plan: "SILVER" });
    const anon = await counterSale(ss(), { walkIn: true, items: [{ variantId: grip.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const guest = await counterSale(ss(), { walkIn: true, customerPhone: "9811033445", items: [{ variantId: grip.variantId, qty: 2 }], payments: [{ method: "CASH" }] });
    await counterSale(ss(), { memberId: m.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
    const walk = await listView(w.actors.MANAGER, "sales", { customer: "walkin" });
    expect(walk.rows.map((r) => (r as { code: string }).code).sort()).toEqual([anon.code, guest.code].sort());
    expect((walk.rows as Array<{ code: string; bill_customer_kind: string }>).find((r) => r.code === anon.code)?.bill_customer_kind).toBe("WALK_IN");
    expect((await listView(w.actors.MANAGER, "sales", { customer: "member" })).rows).toHaveLength(1);
    const ledger = await prisma.ledgerEntry.findMany({ where: { billId: { in: [anon.billId, guest.billId] } } });
    expect(ledger.every((l) => l.source === "SHOP")).toBe(true);
    const d = await dashboard(w.actors.OWNER, { period: "TODAY" });
    expect((d as { ops: { shop: { walkInSales: unknown } } }).ops.shop.walkInSales).toEqual({ count: 2, total: anon.total + guest.total, anonymous: 1 });
    await expectIntegrity();
  });
});

describe("v6 §4.3 — staff open only their own area's tills", () => {
  it("TL-1: a till at another area is DRAWER_AREA_MISMATCH; the Manager and the Owner open any till", async () => {
    const desk = await ensureTill(w.actors.OWNER, { name: "Front Desk Till 9", location: "FRONT_DESK" });
    const bar = await ensureTill(w.actors.OWNER, { name: "Bar Till 2", location: "BAR" });
    await closeDrawer(ss(), { cashCounted: 0 });
    await expect(openDrawer(ss(), { drawerId: desk.id, openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await expect(openDrawer(ss(), { drawerId: bar.id, openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await expect(openDrawer(ss(), { area: "DESK", openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 0 });
    await expect(openDrawer(w.actors.FRONT_DESK, { drawerId: bar.id, openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await closeDrawer(w.actors.BAR_STAFF, { cashCounted: 0 });
    await expect(openDrawer(w.actors.BAR_STAFF, { drawerId: desk.id, openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    expect(await prisma.cashDrawerSession.count({ where: { drawerId: { in: [desk.id, bar.id] } } })).toBe(0);
    // Their own areas work.
    expect((await openDrawer(ss(), { area: "SHOP", openingFloat: 0 })).area).toBe("SHOP");
    expect((await openDrawer(w.actors.BAR_STAFF, { drawerId: bar.id, openingFloat: 0 })).drawerId).toBe(bar.id);
    expect((await openDrawer(w.actors.FRONT_DESK, { drawerId: desk.id, openingFloat: 0 })).drawerId).toBe(desk.id);
    // Manager / Owner: any till (here a bar till).
    await closeDrawer(w.actors.MANAGER, { cashCounted: 0 });
    await closeDrawer(w.actors.BAR_STAFF, { cashCounted: 0 });
    expect((await openDrawer(w.actors.MANAGER, { drawerId: bar.id, openingFloat: 0 })).drawerId).toBe(bar.id);
    // The Accountant keeps the office till; the kitchen has none.
    await closeDrawer(w.actors.ACCOUNTANT, { cashCounted: 0 });
    await expect(openDrawer(w.actors.ACCOUNTANT, { area: "DESK", openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    expect((await openDrawer(w.actors.ACCOUNTANT, { area: "OFFICE", openingFloat: 0 })).area).toBe("OFFICE");
    await expect(openDrawer(w.actors.KITCHEN, { area: "BAR", openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await expectIntegrity();
  });

  it("TL-2: the open-drawer picker lists only the tills the role may open (Settings still lists all for the Owner)", async () => {
    await ensureTill(w.actors.OWNER, { name: "Shop Till 2", location: "SHOP" });
    const loc = async (a: typeof ss extends () => infer A ? A : never) => [...new Set((await listTills(a)).map((t) => t.location))].sort();
    expect(await loc(ss())).toEqual(["SHOP"]);
    expect((await listTills(ss())).map((t) => t.name)).toEqual(["Shop Till", "Shop Till 2"]);
    expect(await loc(w.actors.FRONT_DESK)).toEqual(["FRONT_DESK"]);
    expect(await loc(w.actors.BAR_STAFF)).toEqual(["BAR"]);
    expect(await loc(w.actors.ACCOUNTANT)).toEqual(["OFFICE"]);
    expect(await loc(w.actors.MANAGER)).toEqual(["BAR", "FRONT_DESK", "OFFICE", "SHOP"]);
    expect(await listTills(w.actors.KITCHEN)).toEqual([]);
    expect((await listTills(w.actors.OWNER, { includeInactive: true })).length).toBe(7);
    expect((await myDrawer(ss())).rules.locations).toEqual(["SHOP"]);
  });

  it("TL-3: open sessions at the wrong area are listed for a manager (nothing is closed)", async () => {
    const desk = await ensureTill(w.actors.OWNER, { name: "Front Desk Till 4", location: "FRONT_DESK" });
    await closeDrawer(ss(), { cashCounted: 0 });
    // A session from before TL-1 (the old open dialog defaulted to the front desk).
    const legacy = await prisma.cashDrawerSession.create({ data: { userId: ss().userId, drawerId: desk.id, area: "DESK", openingFloat: 0, openedAt: clock.now(), status: "OPEN" } });
    const rows = await mismatchedOpenSessions();
    expect(rows.map((r) => [r.sessionId, r.till, r.role, r.allowed])).toEqual([[legacy.id, "Front Desk Till 4", "SHOP_STAFF", ["SHOP"]]]);
    expect((await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: legacy.id } })).closedAt).toBeNull();
  });

  it("TL-4: tills are created idempotently by name; a busy location never gets a new numbered till", async () => {
    const a = await ensureTill(w.actors.OWNER, { name: "Shop Till", location: "SHOP" });
    const b = await ensureTill(w.actors.OWNER, { name: "shop till", location: "SHOP" });
    expect(b.id).toBe(a.id);
    await expect(ensureTill(w.actors.OWNER, { name: "Shop Till", location: "BAR" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ensureTill(w.actors.MANAGER, { name: "Another", location: "BAR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = await prisma.cashDrawer.count();
    // Every shop till is busy (the shop staff member holds the only one): the Owner's legacy SHOP open is refused.
    await closeDrawer(w.actors.OWNER, { cashCounted: 0 });
    await expect(openDrawer(w.actors.OWNER, { area: "SHOP", openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_IN_USE" });
    expect(await prisma.cashDrawer.count()).toBe(before);
  });
});

describe("v6 JR-1 — no split payments on a Junior's or under-18's bill", () => {
  it("JR-1: a Junior's counter sale, tab and bill take one payment for the whole amount; an adult may still split", async () => {
    const grip = await makeProduct(w, { name: "Junior grip", category: "ACCESSORIES", price: 30000, onHand: 20 });
    const junior = await makeMember(w, { name: "Jai Junior", dob: "2013-04-04", plan: "JUNIOR" });
    const adult = await makeMember(w, { name: "Asha Adult", plan: "SILVER" });
    const two = (total: number) => [{ method: "CASH" as const, amount: total - 10000 }, { method: "CARD" as const, amount: 10000, ...CARD_PROOF }];
    // Shop POS.
    const jq = await quoteCart(ss(), { memberId: junior.memberId, items: [{ variantId: grip.variantId, qty: 1 }] });
    expect(jq.noSplit).toBe(true);
    await expect(counterSale(ss(), { memberId: junior.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: two(jq.total) })).rejects.toMatchObject({ code: "JUNIOR_NO_SPLIT" });
    expect((await counterSale(ss(), { memberId: junior.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: [{ method: "CASH" }] })).billStatus).toBe("PAID");
    const aq = await quoteCart(ss(), { memberId: adult.memberId, items: [{ variantId: grip.variantId, qty: 1 }] });
    expect(aq.noSplit).toBe(false);
    expect((await counterSale(ss(), { memberId: adult.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: two(aq.total) })).billStatus).toBe("PAID");
    // Bar tab settle.
    const cat = await createMenuCategory(w.actors.BAR_STAFF, { name: "Juice bar" });
    const juice = await addMenuItem(w.actors.BAR_STAFF, { name: "Orange juice", categoryId: cat.id, price: 15000, kind: "DRINK" });
    const tab = await openTab(w.actors.BAR_STAFF, { memberId: junior.memberId });
    await addLines(w.actors.BAR_STAFF, tab.tabId, { items: [{ menuItemId: juice.id, qty: 2 }] });
    const bill = await getBill(w.actors.BAR_STAFF, tab.billId);
    expect(bill.noSplit).toBe(true);
    await expect(settleTab(w.actors.BAR_STAFF, tab.tabId, { payments: two(bill.due) })).rejects.toMatchObject({ code: "JUNIOR_NO_SPLIT" });
    // A part payment is a split too (several payment rows for one bill) — at the bar and at any counter.
    await expect(settleTab(w.actors.BAR_STAFF, tab.tabId, { payments: [{ method: "CASH", amount: 10000 }] })).rejects.toMatchObject({ code: "JUNIOR_NO_SPLIT" });
    await expect(recordCounterPayment(w.actors.BAR_STAFF, { billId: tab.billId, method: "CASH", amount: 10000 })).rejects.toMatchObject({ code: "JUNIOR_NO_SPLIT" });
    expect((await settleTab(w.actors.BAR_STAFF, tab.tabId, { payments: [{ method: "CASH", amount: bill.due }] })).status).toBe("SETTLED");
    // An adult's tab may still be split.
    const atab = await openTab(w.actors.BAR_STAFF, { memberId: adult.memberId });
    await addLines(w.actors.BAR_STAFF, atab.tabId, { items: [{ menuItemId: juice.id, qty: 2 }] });
    const abill = await getBill(w.actors.BAR_STAFF, atab.billId);
    expect(abill.noSplit).toBe(false);
    expect((await settleTab(w.actors.BAR_STAFF, atab.tabId, { payments: two(abill.due) })).status).toBe("SETTLED");
    await expectIntegrity();
  });

  it("JR-1: an under-18 on an adult plan counts too (BR-5's age test)", async () => {
    const grip = await makeProduct(w, { name: "Teen grip", category: "ACCESSORIES", price: 30000, onHand: 5 });
    const teen = await makeMember(w, { name: "Tara Teen", dob: "2010-01-01", plan: "SILVER" });
    const q = await quoteCart(ss(), { memberId: teen.memberId, items: [{ variantId: grip.variantId, qty: 1 }] });
    expect([q.tier, q.noSplit]).toEqual(["SILVER", true]);
    await expect(counterSale(ss(), { memberId: teen.memberId, items: [{ variantId: grip.variantId, qty: 1 }], payments: [{ method: "CASH", amount: q.total - 100 }, { method: "UPI", amount: 100, reference: utr() }] })).rejects.toMatchObject({ code: "JUNIOR_NO_SPLIT" });
  });
});
