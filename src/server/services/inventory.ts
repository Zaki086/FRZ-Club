// One inventory (plan §5.8 SH-1…SH-9; R-18, R-23; E-09). Counter and online use the same variant row through
// atomic conditional updates; every change writes a stock_movements row in the same transaction (SH-3).
import type { StockReason } from "@prisma/client";
import { z } from "zod";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { notify } from "./notifications";

type VariantRow = { id: string; sku: string; label: string; on_hand: number; reserved: number; reorder_level: number; product_name: string; track_stock: boolean };

async function variantInfo(tx: Tx, variantId: string): Promise<VariantRow> {
  const rows = await tx.$queryRaw<VariantRow[]>`
    SELECT v.id, v.sku, v.label, v.on_hand, v.reserved, v.reorder_level, p.name AS product_name, p.track_stock
      FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ${variantId}`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Product was not found.");
  return rows[0];
}

const itemName = (v: Pick<VariantRow, "product_name" | "label">) => `${v.product_name}${v.label && v.label !== "Standard" ? ` (${v.label})` : ""}`;

async function movement(
  tx: Tx,
  actor: Actor,
  m: { variantId: string; onHand: number; reserved: number; reason: StockReason; refType?: string; refId?: string; unitCost?: number | null; note?: string | null },
) {
  const mv = await tx.stockMovement.create({
    data: {
      variantId: m.variantId, qtyOnHandDelta: m.onHand, qtyReservedDelta: m.reserved, reason: m.reason,
      refType: m.refType ?? null, refId: m.refId ?? null, unitCost: m.unitCost ?? null, note: m.note ?? null, actorId: actorId(actor),
    },
  });
  await checkLowStock(tx, m.variantId, mv.id);
}

function insufficient(v: VariantRow, qty: number): DomainError {
  const available = v.on_hand - v.reserved;
  const held = v.reserved ? ` (${v.reserved} reserved for online orders)` : "";
  return new DomainError(
    "INSUFFICIENT_STOCK",
    available <= 0
      ? `${itemName(v)} is out of stock${held}.`
      : `Only ${available} of ${itemName(v)} available${held}; ${qty} requested.`,
    { sku: v.sku, available, requested: qty },
  );
}

/** SH-4: counter sale — `on_hand −= q` only if `on_hand − reserved ≥ q`. Zero rows → INSUFFICIENT_STOCK. */
export async function counterDecrement(tx: Tx, actor: Actor, variantId: string, qty: number, ref: { type: string; id: string }) {
  const v = await variantInfo(tx, variantId);
  if (!v.track_stock) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE product_variants SET on_hand = on_hand - ${qty}, updated_at = now()
     WHERE id = ${variantId} AND on_hand - reserved >= ${qty} RETURNING id`;
  if (!rows.length) throw insufficient(await variantInfo(tx, variantId), qty);
  await movement(tx, actor, { variantId, onHand: -qty, reserved: 0, reason: "COUNTER_SALE", refType: ref.type, refId: ref.id });
}

/** SH-5: online checkout reserves stock atomically (`reserved += q` only if available). */
export async function reserve(tx: Tx, actor: Actor, variantId: string, qty: number, ref: { type: string; id: string }) {
  const v = await variantInfo(tx, variantId);
  if (!v.track_stock) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE product_variants SET reserved = reserved + ${qty}, updated_at = now()
     WHERE id = ${variantId} AND on_hand - reserved >= ${qty} RETURNING id`;
  if (!rows.length) throw insufficient(await variantInfo(tx, variantId), qty);
  await movement(tx, actor, { variantId, onHand: 0, reserved: qty, reason: "RESERVE", refType: ref.type, refId: ref.id });
}

/** Release a reservation (cancelled / expired order). */
export async function release(tx: Tx, actor: Actor, variantId: string, qty: number, ref: { type: string; id: string }) {
  const v = await variantInfo(tx, variantId);
  if (!v.track_stock) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE product_variants SET reserved = reserved - ${qty}, updated_at = now()
     WHERE id = ${variantId} AND reserved >= ${qty} RETURNING id`;
  if (!rows.length) throw new Error(`release of ${qty} exceeds the reservation on ${v.sku}`);
  await movement(tx, actor, { variantId, onHand: 0, reserved: -qty, reason: "RELEASE", refType: ref.type, refId: ref.id });
}

/** SH-6: on COLLECTED / OUT_FOR_DELIVERY the reserved units leave the shelf (`on_hand −= q`, `reserved −= q`). */
export async function fulfil(tx: Tx, actor: Actor, variantId: string, qty: number, ref: { type: string; id: string }) {
  const v = await variantInfo(tx, variantId);
  if (!v.track_stock) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE product_variants SET on_hand = on_hand - ${qty}, reserved = reserved - ${qty}, updated_at = now()
     WHERE id = ${variantId} AND reserved >= ${qty} AND on_hand >= ${qty} RETURNING id`;
  if (!rows.length) throw new Error(`fulfil of ${qty} exceeds the reservation on ${v.sku}`);
  await movement(tx, actor, { variantId, onHand: -qty, reserved: -qty, reason: "ONLINE_FULFIL", refType: ref.type, refId: ref.id });
}

/** SH-10: returned goods go back on the shelf. */
export async function restock(tx: Tx, actor: Actor, variantId: string, qty: number, ref: { type: string; id: string }) {
  const v = await variantInfo(tx, variantId);
  if (!v.track_stock) return;
  await tx.$executeRaw`UPDATE product_variants SET on_hand = on_hand + ${qty}, updated_at = now() WHERE id = ${variantId}`;
  await movement(tx, actor, { variantId, onHand: qty, reserved: 0, reason: "RETURN", refType: ref.type, refId: ref.id });
}

/** SH-8: alert once when available ≤ reorder level; the flag clears when restocked above it. */
export async function checkLowStock(tx: Tx, variantId: string, episodeKey?: string) {
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, include: { product: true } });
  if (!v.product.trackStock) return;
  const available = v.onHand - v.reserved;
  const low = available <= v.reorderLevel;
  if (low && !v.lowStockAlerted) {
    await tx.productVariant.update({ where: { id: v.id }, data: { lowStockAlerted: true } });
    await notify(tx, {
      roles: ["SHOP_STAFF", "MANAGER", "OWNER"],
      type: "LOW_STOCK",
      title: `Low stock: ${v.product.name}${v.label !== "Standard" ? ` (${v.label})` : ""}`,
      body: `${available} available (reorder level ${v.reorderLevel}). SKU ${v.sku}.`,
      link: "/app/shop/stock?filter=low",
      // One alert per "low episode": the flag blocks repeats until a restock clears it.
      dedupeKey: `low-stock:${v.id}:${episodeKey ?? `${v.onHand}-${v.reserved}-${v.updatedAt.getTime()}`}`,
    });
  } else if (!low && v.lowStockAlerted) {
    await tx.productVariant.update({ where: { id: v.id }, data: { lowStockAlerted: false } });
  }
}

// ───────────── receipts and adjustments (SH-9) ─────────────

export const receiveSchema = z.object({
  variantId: z.string().min(1),
  qty: z.number().int().positive().max(10_000),
  unitCost: z.number().int().min(0),
  supplier: z.string().trim().min(2).max(120),
  createPayable: z.boolean().default(false),
  inputGst: z.number().int().min(0).default(0),
  dueInDays: z.number().int().min(0).max(120).default(30),
});

export async function receiveStock(actor: Actor, raw: z.input<typeof receiveSchema>, outer?: Tx) {
  assertCan(actor, "shop.stock");
  const input = receiveSchema.parse(raw);
  return withTx(async (tx) => {
    const v = await variantInfo(tx, input.variantId);
    if (!v.track_stock) throw new DomainError("VALIDATION_FAILED", `${itemName(v)} is a service and has no stock.`);
    await tx.$executeRaw`UPDATE product_variants SET on_hand = on_hand + ${input.qty}, updated_at = now() WHERE id = ${input.variantId}`;
    const receiptId = `rcpt_${globalThis.crypto.randomUUID().slice(0, 12)}`;
    await movement(tx, actor, { variantId: input.variantId, onHand: input.qty, reserved: 0, reason: "RECEIPT", refType: "receipt", refId: receiptId, unitCost: input.unitCost, note: `from ${input.supplier}` });
    let expenseId: string | null = null;
    if (input.createPayable && input.unitCost > 0) {
      const { createExpenseTx } = await import("./expenses");
      const e = await createExpenseTx(tx, actor, {
        vendor: input.supplier, category: "STOCK_PURCHASE", description: `${input.qty} × ${itemName(v)} (${v.sku})`,
        amount: input.qty * input.unitCost, inputGst: input.inputGst, dueInDays: input.dueInDays, refType: "receipt", refId: receiptId,
      });
      expenseId = e.id;
    }
    await audit(tx, actor, "stock.receive", "product_variant", input.variantId, { after: { qty: input.qty, unitCost: input.unitCost, supplier: input.supplier, expenseId } });
    return { receiptId, expenseId };
  }, outer);
}

export const adjustSchema = z.object({
  variantId: z.string().min(1),
  delta: z.number().int().refine((d) => d !== 0, "delta must not be zero"),
  reason: z.string().trim().min(3).max(200),
});

/** Stock count correction (damage, loss, recount). Never takes on_hand below what is reserved. */
export async function adjustStock(actor: Actor, raw: z.infer<typeof adjustSchema>) {
  assertCan(actor, "shop.stock");
  const input = adjustSchema.parse(raw);
  return withTx(async (tx) => {
    const v = await variantInfo(tx, input.variantId);
    if (!v.track_stock) throw new DomainError("VALIDATION_FAILED", `${itemName(v)} is a service and has no stock.`);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE product_variants SET on_hand = on_hand + ${input.delta}, updated_at = now()
       WHERE id = ${input.variantId} AND on_hand + ${input.delta} >= reserved RETURNING id`;
    if (!rows.length) throw new DomainError("INSUFFICIENT_STOCK", `Can't remove ${-input.delta}: ${v.on_hand} on hand and ${v.reserved} reserved for online orders.`);
    await movement(tx, actor, { variantId: input.variantId, onHand: input.delta, reserved: 0, reason: "ADJUSTMENT", refType: "adjustment", note: input.reason });
    await audit(tx, actor, "stock.adjust", "product_variant", input.variantId, { before: { onHand: v.on_hand }, after: { onHand: v.on_hand + input.delta }, reason: input.reason });
    return { variantId: input.variantId, onHand: v.on_hand + input.delta };
  });
}

// ───────────── read side ─────────────

export async function listStock(actor: Actor, opts: { lowOnly?: boolean; q?: string } = {}) {
  assertCan(actor, "shop.view");
  const variants = await prisma.productVariant.findMany({
    where: { archivedAt: null, product: { archivedAt: null, name: opts.q ? { contains: opts.q, mode: "insensitive" } : undefined } },
    include: { product: true },
    orderBy: [{ product: { category: "asc" } }, { product: { name: "asc" } }, { label: "asc" }],
  });
  const rows = variants.map((v) => ({
    variantId: v.id, sku: v.sku, product: v.product.name, productId: v.productId, label: v.label, category: v.product.category,
    price: v.price, onHand: v.onHand, reserved: v.reserved, available: v.onHand - v.reserved, reorderLevel: v.reorderLevel,
    trackStock: v.product.trackStock, low: v.product.trackStock && v.onHand - v.reserved <= v.reorderLevel,
  }));
  return opts.lowOnly ? rows.filter((r) => r.low) : rows;
}

export async function listMovements(actor: Actor, variantId: string) {
  assertCan(actor, "shop.view");
  return prisma.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: "desc" }, take: 200 });
}
