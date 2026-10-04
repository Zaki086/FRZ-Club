// Shop (plan §5.8 SH-1…SH-12; R-17…R-24; E-09, E-10). Counter and online sales share one inventory (inventory.ts)
// and one pricing engine (pricing.ts). Prices are always recomputed on the server.
import type { OrderStatus, Prisma, ProductCategory, TicketStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode } from "@/lib/codes";
import { email as emailField, mobilePhone, optionalContact } from "@/lib/validation/contact";
import { formatINR } from "@/lib/money";
import { DAY, fmtDateTime, HOUR, istDate, MINUTE } from "@/lib/time";
import { nextSeq, pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { addBillLines, billDue, closeBill, createBill, netPaid, refreshBill, voidBillLines } from "./bills";
import { findOrCreateGuest } from "./guests";
import { idempotent } from "./idempotency";
import { counterDecrement, fulfil, release, reserve, restock } from "./inventory";
import { notifyMember } from "./channels";
import { notify, queueEmail } from "./notifications";
import { recordSplitPaymentsTx, refundTx, startOnlinePaymentTx } from "./payments";
import { asTaxCategory, priceLine, quoteShop, type ShopItem } from "./pricing";
import { assertCapability, isEnabled } from "./capabilities";
import { getSettings } from "./settings";
import { absoluteUrl } from "@/lib/url";

const itemSchema = z.object({ variantId: z.string().min(1), qty: z.number().int().positive().max(50) });

async function loadItems(tx: Tx | typeof prisma, items: Array<{ variantId: string; qty: number }>): Promise<Array<ShopItem & { trackStock: boolean; isRestring: boolean; productId: string }>> {
  if (!items.length) throw new DomainError("VALIDATION_FAILED", "The cart is empty.");
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.variantId, (merged.get(i.variantId) ?? 0) + i.qty);
  const out = [];
  for (const [variantId, qty] of merged) {
    const v = await tx.productVariant.findUnique({ where: { id: variantId }, include: { product: true } });
    if (!v || v.archivedAt || v.product.archivedAt) throw new DomainError("NOT_FOUND", "A product in the cart is no longer sold.");
    out.push({
      variantId, qty, name: `${v.product.name}${v.label !== "Standard" ? ` — ${v.label}` : ""}`, price: v.price,
      taxCategory: v.taxCategory, hsnSac: v.hsnSac, trackStock: v.product.trackStock, isRestring: v.product.isRestring, productId: v.productId,
    });
  }
  return out;
}

// ───────────── catalogue (R-17, SH-8 public stock labels) ─────────────

export async function listCatalogue(opts: { category?: string; q?: string } = {}) {
  const s = await getSettings();
  const products = await prisma.product.findMany({
    where: {
      archivedAt: null,
      category: opts.category ? (opts.category as ProductCategory) : undefined,
      name: opts.q ? { contains: opts.q, mode: "insensitive" } : undefined,
    },
    include: { variants: { where: { archivedAt: null }, orderBy: { price: "asc" } } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  const images = await prisma.productImage.findMany({ where: { productId: { in: products.map((p) => p.id) } }, orderBy: { sort: "asc" } });
  // D-79: the price a walk-in pays right now, from the one pricing engine (price book + any shop discount in effect).
  // Members' plan discounts and tier-only offers are applied at checkout.
  const all = products.flatMap((p) => p.variants.map((v) => ({ variantId: v.id, qty: 1, name: p.name, price: v.price, taxCategory: v.taxCategory, hsnSac: v.hsnSac })));
  const walkIn = all.length ? await quoteShop(prisma, { date: istDate(clock.now()), items: all }, s) : null;
  const priced = (variantId: string, fallback: number) => {
    const l = walkIn?.lines.find((x) => x.variantId === variantId);
    if (!l) return { price: fallback, offerPrice: null, offer: null };
    const words = l.explanation.replace(/^Walk-in · /, "").replace(/ \(better than .*\)$/, "");
    return { price: l.unitPrice, offerPrice: l.discountAmount > 0 ? l.netAmount : null, offer: l.discountAmount > 0 ? words : null };
  };
  return products
    .filter((p) => p.variants.length)
    .map((p) => ({
      id: p.id, name: p.name, brand: p.brand, category: p.category, description: p.description, imageUrl: p.imageUrl,
      // v3 §9.3: every photo (cover first) for the product page.
      images: images.filter((i) => i.productId === p.id).map((i) => ({ url: i.url, thumbUrl: i.thumbUrl })),
      trackStock: p.trackStock, isRestring: p.isRestring,
      variants: p.variants.map((v) => {
        const available = p.trackStock ? v.onHand - v.reserved : null;
        return {
          id: v.id, sku: v.sku, barcode: v.barcode, label: v.label, ...priced(v.id, v.price), available,
          stockLabel: available === null ? "Service" : available <= 0 ? "Out of stock" : available <= s.public_low_stock_threshold ? `Only ${available} left` : "In stock",
          inStock: available === null || available > 0,
        };
      }),
    }));
}

/** PR-9 preview for the cart / POS. Confirm recomputes everything. */
export async function quoteCart(actor: Actor, raw: { memberId?: string | null; items: Array<{ variantId: string; qty: number }>; fulfilment?: "PICKUP" | "DELIVERY" }) {
  const s = await getSettings();
  let memberId = raw.memberId ?? null;
  if (actor.kind === "USER" && actor.role === "MEMBER") memberId = actor.memberId;
  const items = await loadItems(prisma, raw.items);
  const quote = await quoteShop(prisma, { memberId, date: istDate(clock.now()), items, deliveryFee: raw.fulfilment === "DELIVERY" ? s.delivery.fee : 0 }, s);
  // v6 JR-1: a Junior's / under-18's sale is paid in one go — the POS offers no split.
  const { isJuniorBill } = await import("./payments");
  return { ...quote, noSplit: await isJuniorBill(prisma, { memberId, tier: quote.tier }) };
}

// ───────────── counter sale (SH-4, R-19, E-10) ─────────────

export const counterSaleSchema = z.object({
  memberId: z.string().optional(),
  // v6 WI-1: the "Walk-in customer" switch — no member on the sale (WI-2: priced at the WALK_IN tier).
  walkIn: z.boolean().optional(),
  customerName: z.string().trim().max(100).optional(),
  // v5 CV-1: a walk-in's mobile (optional) — the shared validator.
  customerPhone: optionalContact(mobilePhone),
  items: z.array(itemSchema).min(1).max(40),
  payments: z.array(z.object({
    method: z.enum(["CASH", "CARD", "UPI"]),
    amount: z.number().int().positive().optional(),
    reference: z.string().max(100).optional(),
    tendered: z.number().int().positive().optional(),
    cardLast4: z.string().max(4).optional(),
    approvalCode: z.string().max(20).optional(),
  })).min(1).max(4),
  restring: z.object({ racket: z.string().trim().min(2).max(120), notes: z.string().max(300).default("") }).optional(),
});

/** SH-4: atomic stock decrement for every line + full payment, all in one transaction (or nothing). */
export async function counterSaleTx(tx: Tx, actor: Actor, raw: z.input<typeof counterSaleSchema>) {
  assertCan(actor, "shop.counter");
  const input = counterSaleSchema.parse(raw);
  const s = await getSettings(tx);
  const today = istDate(clock.now());
  let memberId: string | null = null;
  let guestId: string | null = null;
  let customerName = input.customerName || "Walk-in customer";
  if (input.walkIn && input.memberId) {
    throw new DomainError("VALIDATION_FAILED", "A walk-in sale has no member. Switch “Walk-in customer” off to sell to a member at their price.");
  }
  if (input.memberId) {
    const m = await tx.member.findUnique({ where: { id: input.memberId } });
    if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
    memberId = m.id;
    customerName = m.name;
  } else if (input.customerPhone) {
    // v6 WI-4: with a phone the walk-in is linked to (or becomes) a guest record — even when the number is a member's,
    // the sale stays a walk-in at walk-in prices (WI-3: member pricing only when staff switch to the member).
    const g = await findOrCreateGuest(tx, { name: customerName, phone: input.customerPhone });
    guestId = g.id;
  }
  // v6 WI-4: without a phone it is an anonymous walk-in sale — no person on the bill (customer kind WALK_IN).
  const items = await loadItems(tx, input.items);
  const needsTicket = items.some((i) => i.isRestring);
  if (needsTicket && !input.restring) throw new DomainError("VALIDATION_FAILED", "Describe the racket for the restringing ticket.");
  if (needsTicket && !memberId && !guestId) throw new DomainError("VALIDATION_FAILED", "Restringing needs a member or a customer phone so we can tell them when it's ready.");
  const quote = await quoteShop(tx, { memberId, date: today, items }, s);
  const code = formatCode("counterSale", await nextSeq(tx, CODE_SEQUENCE.counterSale));
  const bill = await createBill(tx, {
    sourceType: "COUNTER_SALE", customer: { memberId, guestId, name: customerName }, tier: quote.tier, lines: quote.lines, createdBy: actorId(actor),
  });
  const sale = await tx.counterSale.create({ data: { code, memberId, guestId, billId: bill.id, soldBy: actorId(actor) ?? "system" } });
  await tx.bill.update({ where: { id: bill.id }, data: { sourceId: sale.id } });
  for (const i of items) await counterDecrement(tx, actor, i.variantId, i.qty, { type: "counter_sale", id: sale.id });
  // Full payment, same transaction. One part without an amount means "the whole total".
  const parts = input.payments.length === 1 && input.payments[0].amount === undefined ? [{ ...input.payments[0], amount: quote.total }] : input.payments;
  const paid = parts.reduce((a, p) => a + (p.amount ?? 0), 0);
  if (quote.total > 0 && paid !== quote.total) {
    throw new DomainError("VALIDATION_FAILED", `Payments add up to ${formatINR(paid)} but the sale total is ${formatINR(quote.total)}. A counter sale must be paid in full.`, { total: quote.total, paid });
  }
  let changeGiven = 0;
  if (quote.total > 0) {
    const r = await recordSplitPaymentsTx(tx, actor, bill.id, parts.map((p) => ({ ...p, amount: p.amount! })));
    changeGiven = r.changeGiven;
  }
  const tickets: string[] = [];
  if (needsTicket && input.restring) {
    for (const i of items.filter((x) => x.isRestring)) {
      for (let n = 0; n < i.qty; n++) {
        const tcode = formatCode("serviceTicket", await nextSeq(tx, CODE_SEQUENCE.serviceTicket));
        const t = await tx.serviceTicket.create({
          data: {
            code: tcode, memberId, guestId, customerName, variantId: i.variantId, racket: input.restring.racket, notes: input.restring.notes,
            promisedAt: new Date(clock.now().getTime() + s.restring_turnaround_hours * HOUR), billId: bill.id, createdBy: actorId(actor),
          },
        });
        tickets.push(t.code);
        await audit(tx, actor, "service_ticket.create", "service_ticket", t.id, { after: { code: tcode, racket: input.restring.racket } });
      }
    }
  }
  const final = await tx.bill.findUniqueOrThrow({ where: { id: bill.id } });
  await audit(tx, actor, "counter_sale.create", "counter_sale", sale.id, {
    after: { code, total: quote.total, items: items.map((i) => `${i.qty}× ${i.name}`), customerKind: final.customerKind, tier: quote.tier },
  });
  return {
    saleId: sale.id, code, billId: bill.id, total: final.total, billStatus: final.status, discountTotal: final.discountTotal, changeGiven, tickets, lines: quote.lines,
    // v6 WI-4/WI-5: the receipt says "Walk-in" for anyone who isn't a member; WALK_IN = anonymous (no phone).
    tier: quote.tier, customerKind: final.customerKind, walkIn: !memberId,
  };
}

export async function counterSale(actor: Actor, raw: z.input<typeof counterSaleSchema>, idempotencyKey?: string | null) {
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "shop.counter_sale", body: raw }, () => counterSaleTx(tx, actor, raw)),
  );
}

/**
 * v6 WI-3: does the walk-in phone typed at the counter belong to a member? The POS then asks "This number belongs to
 * {name} ({code}) — use member pricing?" — one tap switches the sale to that member; nothing changes on its own.
 */
export async function walkInPhoneMembers(actor: Actor, rawPhone: string) {
  assertCan(actor, "shop.counter");
  const parsed = mobilePhone.safeParse(rawPhone);
  if (!parsed.success) return { phone: null, members: [] };
  const rows = await prisma.member.findMany({ where: { phone: parsed.data, anonymisedAt: null }, orderBy: { name: "asc" }, take: 5 });
  const { effectiveStatus } = await import("./membership");
  const today = istDate(clock.now());
  const members = await Promise.all(rows.map(async (m) => ({ id: m.id, memberCode: m.memberCode, name: m.name, phone: m.phone, status: await effectiveStatus(m.id, today) })));
  return { phone: parsed.data, members, prompt: members.map((m) => `This number belongs to ${m.name} (${m.memberCode}) — use member pricing?`) };
}

/**
 * v6 WI-5: a counter sale found from its receipt — the receipt code typed in (CS-…) or the receipt QR scanned
 * (`RC1.…`, signed). Anonymous walk-in sales have no person, so the receipt is how they are found for a return or
 * a refund.
 */
export async function findSaleByReceipt(actor: Actor, text: string) {
  assertCan(actor, "shop.view");
  const t = String(text ?? "").trim().slice(0, 200);
  const { isReceiptToken, verifyReceiptToken } = await import("./receipt-qr");
  let where: Prisma.CounterSaleWhereInput;
  let via: "RECEIPT_QR" | "RECEIPT_CODE" = "RECEIPT_CODE";
  if (isReceiptToken(t)) {
    const billId = verifyReceiptToken(t);
    if (!billId) throw new DomainError("INVALID_REFUND_QR", "This receipt QR is not valid (it may have been altered). Type the receipt code instead.");
    where = { billId };
    via = "RECEIPT_QR";
  } else {
    if (t.length < 3) throw new DomainError("VALIDATION_FAILED", "Type the receipt code (e.g. CS-000123) or scan the receipt QR.");
    where = { code: { equals: t, mode: "insensitive" } };
  }
  const sale = await prisma.counterSale.findFirst({ where });
  if (!sale) throw new DomainError("NOT_FOUND", "No counter sale has that receipt.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: sale.billId }, include: { lines: true, payments: true } });
  return {
    via, saleId: sale.id, code: sale.code, billId: bill.id, at: bill.createdAt, customer: bill.customerName, customerKind: bill.customerKind, tier: bill.tier,
    total: bill.total, refunded: bill.amountRefunded, status: bill.status, lines: bill.lines.filter((l) => !l.voidedAt),
    methods: [...new Set(bill.payments.filter((p) => p.type === "PAYMENT").map((p) => p.method))],
  };
}

// ───────────── online orders (SH-5, SH-6, SH-11; R-20…R-22) ─────────────

export const checkoutSchema = z.object({
  items: z.array(itemSchema).min(1).max(40),
  fulfilment: z.enum(["PICKUP", "DELIVERY"]),
  address: z.string().trim().max(400).optional(),
  pincode: z.string().trim().optional(),
  paymentOption: z.enum(["ONLINE", "PAY_AT_PICKUP", "PAY_ON_DELIVERY"]),
  guest: z.object({
    name: z.string().trim().min(2).max(100),
    phone: mobilePhone,
    email: optionalContact(emailField),
  }).optional(),
  returnUrl: z.string().max(300).optional(),
});

export async function checkoutTx(tx: Tx, actor: Actor, raw: z.input<typeof checkoutSchema>) {
  const input = checkoutSchema.parse(raw);
  const s = await getSettings(tx);
  const now = clock.now();
  const isMember = actor.kind === "USER" && actor.role === "MEMBER" && !!actor.memberId;
  if (actor.kind === "USER" && !isMember) throw new DomainError("FORBIDDEN", "Staff sell at the counter; online checkout is for members and visitors.");
  // §1/§2.5: only real options — delivery and online payment exist only when their capabilities are on.
  const onlineOn = await isEnabled("payments.online");
  if (input.fulfilment === "DELIVERY") {
    await assertCapability("delivery");
    if (!input.address || input.address.length < 10) throw new DomainError("VALIDATION_FAILED", "A full delivery address is required for delivery (SH-11).");
    if (!input.pincode || !s.delivery.pincodes.includes(input.pincode)) {
      throw new DomainError("VALIDATION_FAILED", `We don't deliver to PIN code ${input.pincode || "(none given)"} yet. Choose pickup at the club instead.`);
    }
  }
  if (input.paymentOption === "ONLINE") await assertCapability("payments.online");
  if (input.paymentOption === "PAY_AT_PICKUP") {
    if (input.fulfilment !== "PICKUP") throw new DomainError("VALIDATION_FAILED", "Pay at pickup is only for orders collected at the club.");
    if (!isMember && onlineOn) throw new DomainError("VALIDATION_FAILED", "Pay at pickup is available to logged-in members; please pay online.");
  }
  if (input.paymentOption === "PAY_ON_DELIVERY") {
    if (input.fulfilment !== "DELIVERY") throw new DomainError("VALIDATION_FAILED", "Pay on delivery is only for delivered orders.");
    if (onlineOn) throw new DomainError("VALIDATION_FAILED", "Delivered orders are paid online.");
  }
  let memberId: string | null = null;
  let guestId: string | null = null;
  let customerName: string;
  let email: string | null = null;
  if (isMember) {
    const m = await tx.member.findUniqueOrThrow({ where: { id: actor.memberId! } });
    memberId = m.id;
    customerName = m.name;
    email = m.email;
  } else {
    if (!input.guest) throw new DomainError("VALIDATION_FAILED", "Please enter your name and mobile number.");
    const g = await findOrCreateGuest(tx, { name: input.guest.name, phone: input.guest.phone, email: input.guest.email ?? null });
    guestId = g.id;
    customerName = input.guest.name;
    email = input.guest.email ?? g.email;
  }
  const items = await loadItems(tx, input.items);
  if (items.some((i) => i.isRestring)) throw new DomainError("VALIDATION_FAILED", "Restringing is booked at the shop counter.");
  const deliveryFee = input.fulfilment === "DELIVERY" ? s.delivery.fee : 0;
  const quote = await quoteShop(tx, { memberId, date: istDate(now), items, deliveryFee }, s);
  const code = formatCode("shopOrder", await nextSeq(tx, CODE_SEQUENCE.shopOrder));
  // Holds: online 15 min, pay-at-pickup 48 h; pay-on-delivery orders are not auto-cancelled (staff deliver them).
  const holdMs = input.paymentOption === "ONLINE" ? s.online_hold_minutes * MINUTE : input.paymentOption === "PAY_AT_PICKUP" ? s.pickup_hold_hours * HOUR : null;
  const bill = await createBill(tx, { sourceType: "SHOP_ORDER", customer: { memberId, guestId, name: customerName }, tier: quote.tier, lines: quote.lines, createdBy: actorId(actor) });
  const order = await tx.shopOrder.create({
    data: {
      code, memberId, guestId, fulfilment: input.fulfilment, address: input.address ?? null, deliveryFee,
      paymentOption: input.paymentOption, status: input.paymentOption === "ONLINE" ? "PENDING_PAYMENT" : "CONFIRMED",
      holdExpiresAt: holdMs === null ? null : new Date(now.getTime() + holdMs), billId: bill.id, trackToken: randomBytes(12).toString("base64url"), createdBy: actorId(actor),
    },
  });
  await tx.bill.update({ where: { id: bill.id }, data: { sourceId: order.id } });
  for (const i of items) {
    await tx.shopOrderLine.create({
      data: { orderId: order.id, variantId: i.variantId, qty: i.qty, unitPrice: i.price, netAmount: quote.lines.find((l) => l.variantId === i.variantId)!.netAmount },
    });
    await reserve(tx, actor, i.variantId, i.qty, { type: "shop_order", id: order.id });
  }
  await tx.shopOrderEvent.create({ data: { orderId: order.id, status: order.status, note: "Order placed", actorId: actorId(actor), at: now } });
  await audit(tx, actor, "shop_order.create", "shop_order", order.id, { after: { code, total: quote.total, fulfilment: input.fulfilment, paymentOption: input.paymentOption } });
  let payment: { redirectUrl: string; paymentId: string } | null = null;
  if (input.paymentOption === "ONLINE" && quote.total > 0) {
    const p = await startOnlinePaymentTx(tx, actor, bill.id, { returnUrl: input.returnUrl ?? `/orders/${order.trackToken}`, internal: true });
    payment = { redirectUrl: p.redirectUrl, paymentId: p.paymentId };
  }
  if (email) {
    await queueEmail(tx, {
      to: email, subject: `Order ${code} received`,
      body: `Thanks ${customerName}! Order ${code} (${formatINR(quote.total)}) is ${order.status === "PENDING_PAYMENT" ? "waiting for payment" : "confirmed"}. Track it at ${absoluteUrl(`/orders/${order.trackToken}`)}`,
      dedupeKey: `order-created:${order.id}`,
    });
  }
  return { orderId: order.id, code, status: order.status, total: quote.total, billId: bill.id, trackToken: order.trackToken, holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null, payment };
}

export async function checkout(actor: Actor, raw: z.input<typeof checkoutSchema>, idempotencyKey?: string | null) {
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor) + (raw.guest?.phone ? `:${raw.guest.phone}` : ""), endpoint: "shop.checkout", body: raw }, () => checkoutTx(tx, actor, raw)),
  );
}

async function notifyOrderCustomer(tx: Tx, order: { id: string; code: string; memberId: string | null; guestId: string | null; trackToken: string }, status: string, note: string) {
  const title = `Order ${order.code}: ${status.replace(/_/g, " ").toLowerCase()}`;
  if (order.memberId) {
    const m = await tx.member.findUnique({ where: { id: order.memberId }, select: { userId: true } });
    if (m?.userId && status === "READY_FOR_PICKUP") {
      // v4 §4.1: "order ready for pickup" — in-app, push and email.
      await notifyMember(tx, { event: "ORDER_READY", userId: m.userId, memberId: order.memberId, title: `Ready to collect: order ${order.code}`, body: note, link: "/portal/orders", dedupeKey: `order-status:${order.id}:${status}:${m.userId}` });
    } else if (m?.userId) await notify(tx, { userIds: [m.userId], type: "ORDER_STATUS", title, body: note, link: "/portal/orders", dedupeKey: `order-status:${order.id}:${status}`, email: true });
  } else if (order.guestId) {
    const g = await tx.guest.findUnique({ where: { id: order.guestId } });
    if (g?.email) await queueEmail(tx, { to: g.email, subject: title, body: `${note}\nTrack: ${absoluteUrl(`/orders/${order.trackToken}`)}`, dedupeKey: `order-status:${order.id}:${status}` });
  }
}

/** Bill fully paid → PENDING_PAYMENT orders become CONFIRMED (the hold no longer expires). */
export async function onShopOrderPaid(tx: Tx, billId: string, actor: Actor) {
  const order = await tx.shopOrder.findUnique({ where: { billId } });
  if (!order) return;
  if (order.status === "PENDING_PAYMENT") {
    await tx.shopOrder.update({ where: { id: order.id }, data: { status: "CONFIRMED", holdExpiresAt: null } });
    await tx.shopOrderEvent.create({ data: { orderId: order.id, status: "CONFIRMED", note: "Payment received", actorId: actorId(actor), at: clock.now() } });
    await notifyOrderCustomer(tx, order, "CONFIRMED", `Payment received — we're preparing your order ${order.code}.`);
  } else if (order.paymentOption === "PAY_AT_PICKUP") {
    await tx.shopOrder.update({ where: { id: order.id }, data: { holdExpiresAt: null } });
  }
}

const NEXT: Record<"PICKUP" | "DELIVERY", Partial<Record<OrderStatus, OrderStatus[]>>> = {
  PICKUP: { CONFIRMED: ["READY_FOR_PICKUP"], READY_FOR_PICKUP: ["COLLECTED"] },
  DELIVERY: { CONFIRMED: ["PACKED"], PACKED: ["OUT_FOR_DELIVERY"], OUT_FOR_DELIVERY: ["DELIVERED"] },
};
/** The next steps staff may take on an order (the orders list shows them as buttons). */
export const ORDER_NEXT = NEXT;
const HANDED_OVER: OrderStatus[] = ["COLLECTED", "OUT_FOR_DELIVERY", "DELIVERED"];

async function lockOrder(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM shop_orders WHERE id = ${orderId} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Order was not found.");
  return tx.shopOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
}

/** SH-6: staff move orders forward; COLLECTED / OUT_FOR_DELIVERY take the reserved units off the shelf. */
export async function setOrderStatus(actor: Actor, orderId: string, status: OrderStatus, outer?: Tx) {
  assertCan(actor, "shop.fulfil");
  return withTx(async (tx) => {
    const o = await lockOrder(tx, orderId);
    const allowed = NEXT[o.fulfilment][o.status] ?? [];
    if (!allowed.includes(status)) {
      throw new DomainError("ORDER_STATE_INVALID", `Order ${o.code} is ${o.status.replace(/_/g, " ").toLowerCase()}; it can't move to ${status.replace(/_/g, " ").toLowerCase()}.`, { from: o.status, to: status, allowed });
    }
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: o.billId } });
    if (status === "COLLECTED" && billDue(bill) > 0) {
      throw new DomainError("PAYMENT_DUE", `Order ${o.code} has ${formatINR(billDue(bill))} to pay before it can be handed over.`, { billId: bill.id });
    }
    if (status === "OUT_FOR_DELIVERY" && billDue(bill) > 0 && o.paymentOption !== "PAY_ON_DELIVERY") {
      throw new DomainError("PAYMENT_DUE", `Order ${o.code} is not paid yet.`, { billId: bill.id });
    }
    if (status === "DELIVERED" && billDue(bill) > 0) {
      throw new DomainError("PAYMENT_DUE", `Order ${o.code} has ${formatINR(billDue(bill))} to collect on delivery — record the payment first.`, { billId: bill.id });
    }
    if (HANDED_OVER.includes(status) && !HANDED_OVER.includes(o.status)) {
      for (const l of o.lines) await fulfil(tx, actor, l.variantId, l.qty, { type: "shop_order", id: o.id });
    }
    const now = clock.now();
    await tx.shopOrder.update({ where: { id: o.id }, data: { status, holdExpiresAt: HANDED_OVER.includes(status) ? null : o.holdExpiresAt } });
    await tx.shopOrderEvent.create({ data: { orderId: o.id, status, actorId: actorId(actor), at: now } });
    await audit(tx, actor, "shop_order.status", "shop_order", o.id, { before: { status: o.status }, after: { status } });
    const msg: Partial<Record<OrderStatus, string>> = {
      READY_FOR_PICKUP: `Order ${o.code} is ready to collect at the shop counter.`,
      COLLECTED: `Order ${o.code} was collected. Enjoy!`,
      PACKED: `Order ${o.code} is packed and will be dispatched soon.`,
      OUT_FOR_DELIVERY: `Order ${o.code} is out for delivery.`,
      DELIVERED: `Order ${o.code} was delivered.`,
    };
    await notifyOrderCustomer(tx, o, status, msg[status] ?? `Order ${o.code} is now ${status}.`);
    return { orderId: o.id, status };
  }, outer);
}

/** SH-6: cancel before handover — releases the reservation and refunds whatever was paid. Members may cancel their own. */
export async function cancelOrderTx(tx: Tx, actor: Actor, orderId: string, reason: string) {
  const o = await lockOrder(tx, orderId);
  const own = actor.kind === "USER" && actor.role === "MEMBER" && o.memberId === actor.memberId;
  if (!own && actor.kind !== "SYSTEM") assertCan(actor, "shop.fulfil");
  if (HANDED_OVER.includes(o.status) || o.status === "CANCELLED") {
    throw new DomainError("ORDER_STATE_INVALID", `Order ${o.code} is ${o.status.replace(/_/g, " ").toLowerCase()} and can no longer be cancelled.`);
  }
  for (const l of o.lines) await release(tx, actor, l.variantId, l.qty, { type: "shop_order", id: o.id });
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: o.billId } });
  const paid = netPaid(bill);
  const refund = paid > 0 ? await refundTx(tx, actor, bill.id, paid, { reason: `Order ${o.code} cancelled: ${reason}`, category: "POLICY_CANCELLATION", policy: "ORDER_CANCELLED_BEFORE_HANDOVER" }) : { refunded: 0, pending: 0 };
  await closeBill(tx, bill.id, `Order cancelled: ${reason}`, clock.now());
  await tx.shopOrder.update({ where: { id: o.id }, data: { status: "CANCELLED", cancelReason: reason, holdExpiresAt: null } });
  await tx.shopOrderEvent.create({ data: { orderId: o.id, status: "CANCELLED", note: reason, actorId: actorId(actor), at: clock.now() } });
  await audit(tx, actor, "shop_order.cancel", "shop_order", o.id, { before: { status: o.status }, after: { status: "CANCELLED", refunded: refund.refunded, refundPending: refund.pending }, reason });
  await notifyOrderCustomer(
    tx, o, "CANCELLED",
    `Order ${o.code} was cancelled (${reason}).${refund.refunded ? ` ${formatINR(refund.refunded)} refunded.` : ""}${refund.pending ? ` ${formatINR(refund.pending)} will be refunded at the club counter.` : ""}`,
  );
  return { orderId: o.id, status: "CANCELLED" as const, refunded: refund.refunded, refundPending: refund.pending };
}

export async function cancelOrder(actor: Actor, orderId: string, reason: string) {
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "Please give a reason for cancelling.");
  return withTx((tx) => cancelOrderTx(tx, actor, orderId, reason.trim()));
}

/** Job (every 5 minutes): unpaid online orders after 15 min and pay-at-pickup orders after 48 h are cancelled and released. */
export async function expireHolds(outer?: Tx) {
  return withTx(async (tx) => {
    const now = clock.now();
    const due = await tx.shopOrder.findMany({
      where: { holdExpiresAt: { lte: now }, status: { in: ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP"] } },
      select: { id: true, paymentOption: true, status: true, billId: true },
    });
    const actor = { kind: "SYSTEM" as const, name: "order-hold-job" };
    let cancelled = 0;
    for (const o of due) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: o.billId } });
      if (billDue(bill) === 0) continue; // paid in the meantime
      await cancelOrderTx(tx, actor, o.id, o.paymentOption === "ONLINE" ? "not paid within the payment window" : "not collected and paid within the pickup hold");
      cancelled++;
    }
    return { cancelled };
  }, outer);
}

// ───────────── returns (SH-10) ─────────────

export const returnSchema = z.object({
  billId: z.string().min(1),
  lines: z.array(z.object({ billLineId: z.string().min(1), qty: z.number().int().positive() })).min(1),
  method: z.enum(["CASH", "CARD", "UPI"]).optional(),
  reference: z.string().trim().max(100).optional(),
  reason: z.string().trim().min(3).max(200),
});

/** Within 7 days: RETURN movement + refund of the returned lines (the line is re-issued for the kept quantity). */
export async function returnItems(actor: Actor, raw: z.infer<typeof returnSchema>) {
  assertCan(actor, "shop.counter");
  const input = returnSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const bill = await tx.bill.findUnique({ where: { id: input.billId }, include: { lines: true } });
    if (!bill || !["COUNTER_SALE", "SHOP_ORDER"].includes(bill.sourceType)) throw new DomainError("NOT_FOUND", "Sale was not found.");
    if (clock.now().getTime() - bill.createdAt.getTime() > 7 * DAY) throw new DomainError("ORDER_STATE_INVALID", "Returns are accepted within 7 days of purchase.");
    if (bill.sourceType === "SHOP_ORDER") {
      const o = await tx.shopOrder.findUniqueOrThrow({ where: { billId: bill.id } });
      if (!["COLLECTED", "DELIVERED"].includes(o.status)) throw new DomainError("ORDER_STATE_INVALID", "Only handed-over orders can be returned; cancel the order instead.");
    }
    let refund = 0;
    const now = clock.now();
    for (const r of input.lines) {
      const line = bill.lines.find((l) => l.id === r.billLineId && !l.voidedAt);
      if (!line || !line.variantId) throw new DomainError("VALIDATION_FAILED", "That item is not on this sale.");
      if (r.qty > line.qty) throw new DomainError("VALIDATION_FAILED", `Only ${line.qty} of ${line.description} were sold.`);
      const keep = line.qty - r.qty;
      await voidBillLines(tx, [line.id], now);
      let keptNet = 0;
      if (keep > 0) {
        const kept = priceLine({ description: line.description, qty: keep, unitPrice: line.unitPrice, discountPct: line.discountPct, taxCategory: asTaxCategory(line.taxCategory), hsnSac: line.hsnSac, explanation: line.explanation, variantId: line.variantId }, s);
        await addBillLines(tx, bill.id, [kept]);
        keptNet = kept.netAmount;
      }
      refund += line.netAmount - keptNet;
      await restock(tx, actor, line.variantId, r.qty, { type: "return", id: bill.id });
    }
    let pending = 0;
    if (refund > 0) pending = (await refundTx(tx, actor, bill.id, Math.min(refund, netPaid(bill)), { method: input.method, reference: input.reference, approvalCode: input.reference, reason: `Return: ${input.reason}`, category: "PRODUCT_RETURN", policy: "RETURN_WITHIN_7_DAYS" })).pending;
    await refreshBill(tx, bill.id);
    await audit(tx, actor, "shop.return", "bill", bill.id, { after: { refund, lines: input.lines }, reason: input.reason });
    return { refunded: refund - pending, pending };
  });
}

// ───────────── restring tickets (SH-12, E-10) ─────────────

const TICKET_NEXT: Partial<Record<TicketStatus, TicketStatus[]>> = { RECEIVED: ["IN_PROGRESS"], IN_PROGRESS: ["READY"], READY: ["COLLECTED"] };

export async function setTicketStatus(actor: Actor, ticketId: string, status: TicketStatus) {
  assertCan(actor, "shop.fulfil");
  return withTx(async (tx) => {
    const t = await tx.serviceTicket.findUnique({ where: { id: ticketId } });
    if (!t) throw new DomainError("NOT_FOUND", "Ticket was not found.");
    if (!(TICKET_NEXT[t.status] ?? []).includes(status)) throw new DomainError("ORDER_STATE_INVALID", `Ticket ${t.code} is ${t.status.toLowerCase().replace("_", " ")}; it can't move to ${status.toLowerCase().replace("_", " ")}.`);
    if (status === "COLLECTED") {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: t.billId } });
      if (billDue(bill) > 0) throw new DomainError("PAYMENT_DUE", `Ticket ${t.code} has ${formatINR(billDue(bill))} to pay first.`);
    }
    await tx.serviceTicket.update({ where: { id: t.id }, data: { status } });
    await audit(tx, actor, "service_ticket.status", "service_ticket", t.id, { before: { status: t.status }, after: { status } });
    if (status === "READY") {
      const body = `Your ${t.racket} is restrung and ready to collect at the shop (${t.code}).`;
      if (t.memberId) {
        const m = await tx.member.findUnique({ where: { id: t.memberId }, select: { userId: true } });
        // v4 §4.1: "restring ready" — in-app, push and email.
        if (m?.userId) await notifyMember(tx, { event: "RESTRING_READY", userId: m.userId, memberId: t.memberId, actor, title: "Your racket is ready", body, link: "/portal/orders", dedupeKey: `restring-ready:${t.id}:${m.userId}` });
      } else if (t.guestId) {
        const g = await tx.guest.findUnique({ where: { id: t.guestId } });
        if (g?.email) await queueEmail(tx, { to: g.email, subject: "Your racket is ready", body, dedupeKey: `restring-ready:${t.id}` });
      }
    }
    return { ticketId: t.id, status };
  });
}

export async function listTickets(actor: Actor, opts: { open?: boolean } = {}) {
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    return prisma.serviceTicket.findMany({ where: { memberId: actor.memberId ?? "-" }, orderBy: { createdAt: "desc" } });
  }
  assertCan(actor, "shop.view");
  return prisma.serviceTicket.findMany({
    where: opts.open ? { status: { in: ["RECEIVED", "IN_PROGRESS", "READY"] } } : undefined,
    orderBy: [{ promisedAt: "asc" }],
    take: 300,
  });
}

// ───────────── read side ─────────────

const orderInclude = { lines: true, events: { orderBy: { at: "asc" as const } } } satisfies Prisma.ShopOrderInclude;

async function decorateOrders(orders: Prisma.ShopOrderGetPayload<{ include: typeof orderInclude }>[]) {
  const [bills, variants, members, guests] = await Promise.all([
    prisma.bill.findMany({ where: { id: { in: orders.map((o) => o.billId) } } }),
    prisma.productVariant.findMany({ where: { id: { in: orders.flatMap((o) => o.lines.map((l) => l.variantId)) } }, include: { product: true } }),
    prisma.member.findMany({ where: { id: { in: orders.map((o) => o.memberId).filter((x): x is string => !!x) } }, select: { id: true, name: true, phone: true } }),
    prisma.guest.findMany({ where: { id: { in: orders.map((o) => o.guestId).filter((x): x is string => !!x) } }, select: { id: true, name: true, phone: true } }),
  ]);
  return orders.map((o) => {
    const bill = bills.find((b) => b.id === o.billId)!;
    const who = o.memberId ? members.find((m) => m.id === o.memberId) : guests.find((g) => g.id === o.guestId);
    return {
      id: o.id, code: o.code, status: o.status, fulfilment: o.fulfilment, paymentOption: o.paymentOption, address: o.address,
      holdExpiresAt: o.holdExpiresAt, createdAt: o.createdAt, customer: who?.name ?? bill.customerName, phone: who?.phone ?? null,
      memberId: o.memberId, trackToken: o.trackToken, billId: o.billId, total: bill.total, due: billDue(bill), billStatus: bill.status,
      cancelReason: o.cancelReason,
      lines: o.lines.map((l) => {
        const v = variants.find((x) => x.id === l.variantId);
        return { id: l.id, variantId: l.variantId, name: v ? `${v.product.name}${v.label !== "Standard" ? ` — ${v.label}` : ""}` : "?", qty: l.qty, unitPrice: l.unitPrice, netAmount: l.netAmount };
      }),
      events: o.events.map((e) => ({ status: e.status, at: e.at, note: e.note })),
      nextStatuses: NEXT[o.fulfilment][o.status] ?? [],
    };
  });
}

export async function listOrders(actor: Actor, q: { status?: string } = {}) {
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    const rows = await prisma.shopOrder.findMany({ where: { memberId: actor.memberId ?? "-" }, include: orderInclude, orderBy: { createdAt: "desc" }, take: 100 });
    return decorateOrders(rows);
  }
  assertCan(actor, "shop.view");
  const rows = await prisma.shopOrder.findMany({
    where: q.status === "OPEN" ? { status: { notIn: ["COLLECTED", "DELIVERED", "CANCELLED"] } } : q.status ? { status: q.status as OrderStatus } : undefined,
    include: orderInclude,
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return decorateOrders(rows);
}

export async function getOrderByToken(token: string) {
  const o = await prisma.shopOrder.findUnique({ where: { trackToken: token }, include: orderInclude });
  if (!o) throw new DomainError("NOT_FOUND", "Order was not found.");
  const [d] = await decorateOrders([o]);
  return { ...d, phone: null, memberId: null };
}

export async function listCounterSales(actor: Actor, date?: string) {
  assertCan(actor, "shop.view");
  const day = date ?? istDate(clock.now());
  const sales = await prisma.counterSale.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const bills = await prisma.bill.findMany({ where: { id: { in: sales.map((s) => s.billId) } }, include: { lines: true, payments: true } });
  return sales
    .filter((s) => istDate(s.createdAt) === day)
    .map((s) => {
      const b = bills.find((x) => x.id === s.billId)!;
      return { id: s.id, code: s.code, at: fmtDateTime(s.createdAt), customer: b.customerName, customerKind: b.customerKind, total: b.total, discount: b.discountTotal, status: b.status, billId: b.id, lines: b.lines.filter((l) => !l.voidedAt), methods: [...new Set(b.payments.filter((p) => p.type === "PAYMENT").map((p) => p.method))] };
    });
}

// ───────────── product admin ─────────────

/**
 * Default GST slab for goods (completion pass §9; same rule as migration 0003): sports goods (HSN 9506) and apparel
 * or shoes up to ₹2,500 are 5 %, everything else 18 %. The shop can always choose explicitly.
 */
export function defaultGoodsCategory(category: string, hsnSac: string, price: number): "GOODS_5" | "GOODS_18" {
  if (hsnSac.startsWith("9506")) return "GOODS_5";
  if ((category === "APPAREL" || category === "SHOES") && price <= 250000) return "GOODS_5";
  return "GOODS_18";
}

export const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  brand: z.string().trim().max(60).default(""),
  category: z.enum(["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"]),
  description: z.string().max(2000, "The description is at most 2,000 characters.").default(""),
  // Only photos uploaded to the club's own server (no hot-linked or stock images).
  imageUrl: z.string().regex(/^\/api\/uploads\/product\/[a-z0-9]{24}\.(png|jpg|webp)$/, "Upload the product photo first.").optional(),
  isRestring: z.boolean().default(false),
  variants: z.array(z.object({
    sku: z.string().trim().min(3).max(40),
    label: z.string().trim().min(1).max(60).default("Standard"),
    price: z.number().int().min(0),
    reorderLevel: z.number().int().min(0).optional(),
    taxCategory: z.enum(["GOODS_5", "GOODS_18", "SERVICE"]).optional(),
    hsnSac: z.string().trim().min(4).max(10),
  })).min(1),
});

export async function createProduct(actor: Actor, raw: z.input<typeof productSchema>, outer?: Tx) {
  assertCan(actor, "shop.stock");
  const input = productSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const isService = input.category === "SERVICES";
    const product = await tx.product.create({
      data: { name: input.name, brand: input.brand, category: input.category, description: input.description, imageUrl: input.imageUrl ?? null, trackStock: !isService, isRestring: input.isRestring },
    });
    for (const v of input.variants) {
      await tx.productVariant.create({
        data: {
          productId: product.id, sku: v.sku.toUpperCase(), label: v.label, price: v.price, reorderLevel: isService ? 0 : (v.reorderLevel ?? s.default_reorder_level),
          taxCategory: v.taxCategory ?? (isService ? "SERVICE" : defaultGoodsCategory(input.category, v.hsnSac, v.price)), hsnSac: v.hsnSac,
        },
      });
    }
    await audit(tx, actor, "product.create", "product", product.id, { after: { name: product.name, variants: input.variants.map((v) => v.sku) } });
    return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: { variants: true } });
  }, outer);
}

/**
 * Completion pass §9: set or clear a product's cover photo (an uploaded /api/uploads/product/... file). v3 §9.3: the
 * cover is the first of the product's photos — a new cover goes first, clearing removes the current cover.
 */
export async function setProductImage(actor: Actor, productId: string, url: string | null) {
  assertCan(actor, "shop.stock");
  const imageUrl = url === null ? null : productSchema.shape.imageUrl.parse(url) ?? null;
  return withTx(async (tx) => {
    const p = await tx.product.findUnique({ where: { id: productId } });
    if (!p) throw new DomainError("NOT_FOUND", "Product was not found.");
    const imgs = await tx.productImage.findMany({ where: { productId }, orderBy: { sort: "asc" } });
    if (imageUrl === null) {
      if (imgs[0]) await tx.productImage.delete({ where: { id: imgs[0].id } });
    } else {
      if (imgs.length >= 5) throw new DomainError("VALIDATION_FAILED", "A product has at most 5 photos. Remove one first.");
      for (const [i, img] of [...imgs].reverse().entries()) await tx.productImage.update({ where: { id: img.id }, data: { sort: imgs.length - i } });
      await tx.productImage.create({ data: { productId, url: imageUrl, thumbUrl: imageUrl, sort: 0 } });
    }
    const rest = await tx.productImage.findMany({ where: { productId }, orderBy: { sort: "asc" } });
    for (const [i, r] of rest.entries()) await tx.productImage.update({ where: { id: r.id }, data: { sort: i } });
    const updated = await tx.product.update({ where: { id: p.id }, data: { imageUrl: rest[0]?.url ?? null } });
    await audit(tx, actor, "product.image", "product", p.id, { before: { imageUrl: p.imageUrl }, after: { imageUrl: updated.imageUrl } });
    return { id: updated.id, imageUrl: updated.imageUrl };
  });
}

export const variantUpdateSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  sku: z.string().trim().min(3).max(40).optional(),
  hsnSac: z.string().trim().min(4).max(10).optional(),
  price: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
  taxCategory: z.enum(["GOODS_5", "GOODS_18", "SERVICE"]).optional(),
  // Completion pass P2: the printed barcode (EAN/UPC…); empty clears it.
  barcode: z.string().trim().regex(/^([0-9A-Za-z-]{4,32})?$/, "A barcode is 4–32 letters or digits.").optional(),
});

export async function updateVariant(actor: Actor, variantId: string, raw: z.infer<typeof variantUpdateSchema>) {
  assertCan(actor, "shop.stock");
  const input = variantUpdateSchema.parse(raw);
  // D-79: shop staff set shop prices too (always through the price book below).
  if (input.price !== undefined) assertCan(actor, "shop.pricing");
  const sku = input.sku?.toUpperCase();
  return withTx(async (tx) => {
    const before = await tx.productVariant.findUnique({ where: { id: variantId } });
    if (!before) throw new DomainError("NOT_FOUND", "Product was not found.");
    if (sku && sku !== before.sku && (await tx.productVariant.findFirst({ where: { sku, id: { not: variantId } } }))) throw new DomainError("VALIDATION_FAILED", `SKU ${sku} is already in use.`);
    if (input.price !== undefined && input.price !== before.price) {
      // v3 §9.2: the price goes through the price book (a dated version, in effect now).
      const { setBasePriceTx } = await import("./price-book");
      await setBasePriceTx(tx, actor, { target: `VARIANT:${variantId}`, price: input.price });
    }
    const v = await tx.productVariant.update({
      where: { id: variantId },
      data: {
        label: input.label, sku, hsnSac: input.hsnSac, reorderLevel: input.reorderLevel, taxCategory: input.taxCategory, archivedAt: input.archived === undefined ? undefined : input.archived ? clock.now() : null,
        barcode: input.barcode === undefined ? undefined : input.barcode || null,
      },
    }).catch((e) => {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", `Barcode ${input.barcode} is already on another item.`);
      throw e;
    });
    await audit(tx, actor, "variant.update", "product_variant", variantId, { before, after: v });
    const { checkLowStock } = await import("./inventory");
    await checkLowStock(tx, variantId);
    return v;
  });
}

export function orderAgeLabel(createdAt: Date) {
  const mins = Math.round((clock.now().getTime() - createdAt.getTime()) / MINUTE);
  return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

