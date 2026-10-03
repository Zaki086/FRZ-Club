// Single append-only ledger (plan §5.10 PY-5, E-04). Written only inside the transaction of a successful
// payment, refund, expense payment or payroll payment. Refunds are negative IN entries under the original source.
import type { BillSource, LedgerSource, PaymentMethod } from "@prisma/client";
import type { Tx } from "../db";

export const LEDGER_SOURCE_FOR_BILL: Record<BillSource, LedgerSource> = {
  BOOKING: "COURTS",
  SOCIAL_JOIN: "SOCIAL",
  COUNTER_SALE: "SHOP",
  SHOP_ORDER: "SHOP",
  SERVICE_TICKET: "SHOP",
  BAR_TAB: "BAR",
  MEMBERSHIP: "MEMBERSHIP",
  INVOICE: "INVOICE",
};

export async function writeLedger(
  tx: Tx,
  e: {
    source: LedgerSource;
    direction: "IN" | "OUT";
    method: PaymentMethod;
    amount: number;
    taxAmount?: number;
    billId?: string | null;
    paymentId?: string | null;
    refType?: string | null;
    refId?: string | null;
    description: string;
    occurredAt: Date;
  },
) {
  if (!Number.isInteger(e.amount) || e.amount === 0) throw new Error("ledger amount must be a non-zero integer");
  if (e.direction === "OUT" && e.amount > 0) throw new Error("OUT ledger entries carry negative amounts");
  return tx.ledgerEntry.create({
    data: {
      source: e.source,
      direction: e.direction,
      method: e.method,
      amount: e.amount,
      taxAmount: e.taxAmount ?? 0,
      billId: e.billId ?? null,
      paymentId: e.paymentId ?? null,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      description: e.description,
      occurredAt: e.occurredAt,
    },
  });
}
