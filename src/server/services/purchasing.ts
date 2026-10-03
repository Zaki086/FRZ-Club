// Completion pass P1 (shop): purchase orders and stock takes.
// PO: DRAFT → ORDERED → RECEIVED (each line goes on the shelf with a RECEIPT movement and one STOCK_PURCHASE
// expense is created for the whole order) or CANCELLED. Stock take: count what is on the shelf; every difference is
// posted as a stock adjustment ("Stock take ST-…"), never below what is reserved for online orders.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { prisma, nextSeq, withTx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { createExpenseTx } from "./expenses";
import { adjustStock, receiveStock } from "./inventory";

const poCode = (n: number) => `PO-${String(n).padStart(6, "0")}`;
const stCode = (n: number) => `STK-${String(n).padStart(6, "0")}`;

export const poSchema = z.object({
  supplier: z.string().trim().min(2).max(120),
  note: z.string().trim().max(300).optional(),
  lines: z.array(z.object({ variantId: z.string().min(1), qty: z.number().int().positive().max(10_000), unitCost: z.number().int().min(0), inputGst: z.number().int().min(0).default(0) })).min(1).max(100),
});

export async function createPurchaseOrder(actor: Actor, raw: z.input<typeof poSchema>) {
  assertCan(actor, "shop.stock");
  const input = poSchema.parse(raw);
  return withTx(async (tx) => {
    const variants = await tx.productVariant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, include: { product: true } });
    for (const l of input.lines) {
      const v = variants.find((x) => x.id === l.variantId);
      if (!v) throw new DomainError("NOT_FOUND", "A product on the order was not found.");
      if (!v.product.trackStock) throw new DomainError("VALIDATION_FAILED", `${v.product.name} is a service and can't be ordered.`);
    }
    const po = await tx.purchaseOrder.create({
      data: { code: poCode(await nextSeq(tx, "purchase_order_code_seq")), supplier: input.supplier, note: input.note ?? null, createdBy: actorId(actor), lines: { create: input.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: l.unitCost, inputGst: l.inputGst })) } },
      include: { lines: true },
    });
    await audit(tx, actor, "po.create", "purchase_order", po.id, { after: { code: po.code, supplier: po.supplier, lines: po.lines.length } });
    return po;
  });
}

async function lockPo(tx: Parameters<Parameters<typeof withTx>[0]>[0], id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Purchase order was not found.");
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
}

export async function markOrdered(actor: Actor, id: string) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    const po = await lockPo(tx, id);
    if (po.status !== "DRAFT") throw new DomainError("ORDER_STATE_INVALID", `${po.code} is ${po.status.toLowerCase()}.`);
    await tx.purchaseOrder.update({ where: { id }, data: { status: "ORDERED", orderedAt: clock.now() } });
    await audit(tx, actor, "po.ordered", "purchase_order", id, { before: { status: po.status }, after: { status: "ORDERED" } });
    return { id, status: "ORDERED" as const };
  });
}

/** Goods arrived: every line is received onto the shelf and one payable is created for the order. */
export async function receivePurchaseOrder(actor: Actor, id: string, opts: { dueInDays?: number } = {}) {
  assertCan(actor, "shop.stock");
  return withTx(async (tx) => {
    const po = await lockPo(tx, id);
    if (po.status !== "ORDERED" && po.status !== "DRAFT") throw new DomainError("ORDER_STATE_INVALID", `${po.code} is ${po.status.toLowerCase()}.`);
    for (const l of po.lines) await receiveStock(actor, { variantId: l.variantId, qty: l.qty, unitCost: l.unitCost, supplier: po.supplier, createPayable: false }, tx);
    const amount = po.lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
    const inputGst = po.lines.reduce((a, l) => a + l.inputGst, 0);
    const expense = amount > 0
      ? await createExpenseTx(tx, actor, { vendor: po.supplier, category: "STOCK_PURCHASE", description: `${po.code}: ${po.lines.length} line(s)`, amount, inputGst, dueInDays: opts.dueInDays ?? 30, refType: "purchase_order", refId: po.id })
      : null;
    await tx.purchaseOrder.update({ where: { id }, data: { status: "RECEIVED", receivedAt: clock.now(), expenseId: expense?.id ?? null } });
    await audit(tx, actor, "po.received", "purchase_order", id, { before: { status: po.status }, after: { status: "RECEIVED", amount, expenseId: expense?.id ?? null } });
    return { id, status: "RECEIVED" as const, amount, expenseId: expense?.id ?? null };
  });
}

export async function cancelPurchaseOrder(actor: Actor, id: string, reason: string) {
  assertCan(actor, "shop.stock");
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "Please give a reason for cancelling.");
  return withTx(async (tx) => {
    const po = await lockPo(tx, id);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") throw new DomainError("ORDER_STATE_INVALID", `${po.code} is ${po.status.toLowerCase()}.`);
    await tx.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED", note: [po.note, `Cancelled: ${reason.trim()}`].filter(Boolean).join(" · ") } });
    await audit(tx, actor, "po.cancelled", "purchase_order", id, { before: { status: po.status }, after: { status: "CANCELLED" }, reason });
    return { id, status: "CANCELLED" as const };
  });
}

export async function listPurchaseOrders(actor: Actor) {
  assertCan(actor, "shop.view");
  const pos = await prisma.purchaseOrder.findMany({ include: { lines: true }, orderBy: { createdAt: "desc" }, take: 100 });
  const variants = await prisma.productVariant.findMany({ where: { id: { in: pos.flatMap((p) => p.lines.map((l) => l.variantId)) } }, include: { product: true } });
  return pos.map((p) => ({
    ...p,
    total: p.lines.reduce((a, l) => a + l.qty * l.unitCost, 0),
    lines: p.lines.map((l) => {
      const v = variants.find((x) => x.id === l.variantId);
      return { ...l, name: v ? `${v.product.name}${v.label !== "Standard" ? ` — ${v.label}` : ""}` : "?", sku: v?.sku ?? "" };
    }),
  }));
}

export const stockTakeSchema = z.object({
  note: z.string().trim().max(300).optional(),
  lines: z.array(z.object({ variantId: z.string().min(1), counted: z.number().int().min(0).max(100_000) })).min(1).max(1000),
});

/** Post a stock take: the counted quantity replaces what the system expected; each difference is an adjustment. */
export async function postStockTake(actor: Actor, raw: z.input<typeof stockTakeSchema>) {
  assertCan(actor, "shop.stock");
  const input = stockTakeSchema.parse(raw);
  return withTx(async (tx) => {
    const code = stCode(await nextSeq(tx, "stock_take_code_seq"));
    const variants = await tx.productVariant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, include: { product: true } });
    const lines = [];
    for (const l of input.lines) {
      const v = variants.find((x) => x.id === l.variantId);
      if (!v || !v.product.trackStock) throw new DomainError("NOT_FOUND", "A counted item was not found or has no stock.");
      const fresh = await tx.productVariant.findUniqueOrThrow({ where: { id: v.id } });
      const delta = l.counted - fresh.onHand;
      if (delta !== 0) await adjustStock(actor, { variantId: v.id, delta, reason: `Stock take ${code}` }, tx);
      lines.push({ variantId: v.id, expected: fresh.onHand, counted: l.counted, delta });
    }
    const st = await tx.stockTake.create({ data: { code, note: input.note ?? null, createdBy: actorId(actor), postedAt: clock.now(), lines: { create: lines } } });
    await audit(tx, actor, "stock_take.posted", "stock_take", st.id, { after: { code, counted: lines.length, changed: lines.filter((x) => x.delta).length } });
    return { id: st.id, code, lines, changed: lines.filter((x) => x.delta !== 0).length };
  });
}

export async function listStockTakes(actor: Actor) {
  assertCan(actor, "shop.view");
  return prisma.stockTake.findMany({ include: { lines: true }, orderBy: { postedAt: "desc" }, take: 50 });
}
