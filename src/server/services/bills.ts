// Bills (plan §5.10 PY-1). Every chargeable thing has exactly one bill. Bill lines are immutable snapshots (PR-8);
// totals and paid/refunded amounts are always re-derived from lines and payments in a single UPDATE.
import type { Bill, BillSource, BillStatus } from "@prisma/client";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import type { PricedLine, Tier } from "./pricing";

export type BillCustomer = {
  memberId?: string | null;
  guestId?: string | null;
  businessClientId?: string | null;
  name: string;
};

export async function createBill(
  tx: Tx,
  input: {
    sourceType: BillSource;
    sourceId?: string | null;
    customer: BillCustomer;
    tier: Tier | string;
    lines: PricedLine[];
    createdBy?: string | null;
  },
): Promise<Bill> {
  const bill = await tx.bill.create({
    data: {
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      memberId: input.customer.memberId ?? null,
      guestId: input.customer.guestId ?? null,
      businessClientId: input.customer.businessClientId ?? null,
      customerName: input.customer.name,
      tier: input.tier,
      createdBy: input.createdBy ?? null,
    },
  });
  if (input.lines.length) await addBillLines(tx, bill.id, input.lines);
  return refreshBill(tx, bill.id);
}

export async function addBillLines(tx: Tx, billId: string, lines: PricedLine[]): Promise<string[]> {
  const ids: string[] = [];
  for (const l of lines) {
    const row = await tx.billLine.create({
      data: {
        billId,
        description: l.description,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        discountAmount: l.discountAmount,
        netAmount: l.netAmount,
        taxRate: l.taxRate,
        taxAmount: l.taxAmount,
        taxCategory: l.taxCategory,
        hsnSac: l.hsnSac,
        explanation: l.explanation,
        variantId: l.variantId ?? null,
        menuItemId: l.menuItemId ?? null,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

export async function voidBillLines(tx: Tx, lineIds: string[], at: Date): Promise<void> {
  if (!lineIds.length) return;
  await tx.billLine.updateMany({ where: { id: { in: lineIds }, voidedAt: null }, data: { voidedAt: at } });
}

/**
 * Re-derive total/tax/discount from non-void lines and paid/refunded from SUCCEEDED payments, then the status.
 * One statement, so the bills_money CHECK sees a consistent row.
 */
export async function refreshBill(tx: Tx, billId: string): Promise<Bill> {
  await tx.$executeRaw`
    WITH l AS (
      SELECT coalesce(sum(net_amount), 0)::int AS total,
             coalesce(sum(tax_amount), 0)::int AS tax,
             coalesce(sum(discount_amount), 0)::int AS disc
      FROM bill_lines WHERE bill_id = ${billId} AND voided_at IS NULL
    ), p AS (
      SELECT coalesce(sum(amount) FILTER (WHERE type = 'PAYMENT'), 0)::int AS paid,
             coalesce(sum(amount) FILTER (WHERE type = 'REFUND'), 0)::int AS refunded
      FROM payments WHERE bill_id = ${billId} AND status = 'SUCCEEDED'
    )
    UPDATE bills b SET
      total = l.total, tax_total = l.tax, discount_total = l.disc,
      amount_paid = p.paid, amount_refunded = p.refunded,
      status = (CASE
        WHEN b.closed_at IS NOT NULL THEN
          CASE WHEN p.paid - p.refunded <= 0 THEN (CASE WHEN p.refunded > 0 THEN 'REFUNDED' ELSE 'VOID' END)
               ELSE 'PARTIALLY_REFUNDED' END
        WHEN p.paid - p.refunded >= l.total THEN 'PAID'
        WHEN p.paid - p.refunded > 0 THEN (CASE WHEN p.refunded > 0 THEN 'PARTIALLY_REFUNDED' ELSE 'PARTIAL' END)
        ELSE 'UNPAID' END)::"BillStatus",
      updated_at = now()
    FROM l, p WHERE b.id = ${billId}`;
  const bill = await tx.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new DomainError("NOT_FOUND", "Bill was not found.");
  return bill;
}

/** Amount still owed on a bill. Closed (cancelled/voided) bills owe nothing. */
export function billDue(b: Pick<Bill, "total" | "amountPaid" | "amountRefunded" | "closedAt">): number {
  if (b.closedAt) return 0;
  return Math.max(0, b.total - (b.amountPaid - b.amountRefunded));
}

export function netPaid(b: Pick<Bill, "amountPaid" | "amountRefunded">): number {
  return b.amountPaid - b.amountRefunded;
}

/** Close a bill (source cancelled): nothing more is due. Call refunds first if money must go back. */
export async function closeBill(tx: Tx, billId: string, reason: string, at: Date): Promise<Bill> {
  await tx.bill.update({ where: { id: billId }, data: { closedAt: at, closeReason: reason } });
  return refreshBill(tx, billId);
}

export async function lockBill(tx: Tx, billId: string): Promise<Bill> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bills WHERE id = ${billId} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Bill was not found.");
  const bill = await tx.bill.findUnique({ where: { id: billId } });
  return bill!;
}

export const PAID_STATUSES: BillStatus[] = ["PAID"];
