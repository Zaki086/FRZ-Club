// Payments (plan §5.10 PY-2…PY-7, E-14, E-23). Counter payments are SUCCEEDED when staff record them;
// ONLINE payments stay PENDING until server-side verification. Every successful payment/refund writes the
// ledger in the same transaction.
import type { Bill, BillSource, Payment, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR, roundDiv } from "@/lib/money";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, SYSTEM, type Actor } from "../rbac/actor";
import { assertCan, can, type Capability } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue, lockBill, netPaid, refreshBill } from "./bills";
import { onBillPaid, onBillPaymentChanged } from "./bill-events";
import { activeGateway, gatewayByName } from "./gateway";
import { idempotent } from "./idempotency";
import { LEDGER_SOURCE_FOR_BILL, writeLedger } from "./ledger";

export const BILL_CAPABILITY: Record<BillSource, Capability> = {
  BOOKING: "bookings.any",
  SOCIAL_JOIN: "bookings.any",
  MEMBERSHIP: "members.manage",
  COUNTER_SALE: "shop.counter",
  SHOP_ORDER: "shop.counter",
  SERVICE_TICKET: "shop.counter",
  BAR_TAB: "bar.operate",
  INVOICE: "invoices",
};

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "cash", CARD: "card", UPI: "UPI", ONLINE: "online" };

function assertCanTakePayment(actor: Actor, bill: Bill) {
  if (actor.kind === "SYSTEM") return;
  assertCan(actor, BILL_CAPABILITY[bill.sourceType]);
}

function assertCanViewBill(actor: Actor, bill: Bill) {
  if (actor.kind === "SYSTEM") return;
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    if (bill.memberId && bill.memberId === actor.memberId) return;
    throw new DomainError("FORBIDDEN", "Not allowed: this bill belongs to someone else.");
  }
  if (can(actor, BILL_CAPABILITY[bill.sourceType]) || can(actor, "members.view") || can(actor, "finance.reports")) return;
  throw new DomainError("FORBIDDEN", "Not allowed: you cannot view this bill.");
}

/** The attendance row ("shift") the staff member is currently clocked into, if any (BR-10). */
async function openShiftId(tx: Tx, actor: Actor): Promise<string | null> {
  if (actor.kind !== "USER" || !actor.employeeId) return null;
  const a = await tx.attendance.findFirst({
    where: { employeeId: actor.employeeId, clockOut: null },
    orderBy: { clockIn: "desc" },
    select: { id: true },
  });
  return a?.id ?? null;
}

function proportionalTax(bill: Bill, amount: number): number {
  if (bill.total <= 0 || bill.taxTotal <= 0) return 0;
  const sign = amount < 0 ? -1 : 1;
  return sign * roundDiv(bill.taxTotal * Math.abs(amount), bill.total);
}

// ───────────── counter payments ─────────────

export const counterPaymentSchema = z.object({
  billId: z.string().min(1),
  method: z.enum(["CASH", "CARD", "UPI"]),
  amount: z.number().int().positive(),
  reference: z.string().trim().max(100).optional().nullable(),
  tendered: z.number().int().positive().optional().nullable(),
  note: z.string().max(200).optional().nullable(),
});
export type CounterPaymentInput = z.infer<typeof counterPaymentSchema>;

/** Record a counter payment inside an existing transaction (used by sign-up, counter sale, tab settle…). */
export async function recordPaymentTx(
  tx: Tx,
  actor: Actor,
  input: CounterPaymentInput,
): Promise<{ payment: Payment; bill: Bill; changeGiven: number }> {
  const before = await lockBill(tx, input.billId);
  assertCanTakePayment(actor, before);
  const due = billDue(before);
  if (input.amount > due) {
    throw new DomainError(
      "OVERPAYMENT",
      due === 0
        ? `Nothing is due on this bill (${before.customerName}).`
        : `A payment of ${formatINR(input.amount)} is more than the ${formatINR(due)} still due on this bill.`,
      { due, amount: input.amount },
    );
  }
  if (input.method !== "CASH" && input.tendered) {
    throw new DomainError("VALIDATION_FAILED", "Cash tendered can only be entered for cash payments.");
  }
  if (input.method === "CASH" && input.tendered != null && input.tendered < input.amount) {
    throw new DomainError("VALIDATION_FAILED", `Cash tendered (${formatINR(input.tendered)}) is less than the amount (${formatINR(input.amount)}).`);
  }
  const changeGiven = input.method === "CASH" && input.tendered ? input.tendered - input.amount : 0;
  const now = clock.now();
  const payment = await tx.payment.create({
    data: {
      billId: before.id,
      type: "PAYMENT",
      method: input.method,
      amount: input.amount,
      status: "SUCCEEDED",
      reference: input.reference ?? null,
      tendered: input.method === "CASH" ? (input.tendered ?? input.amount) : null,
      changeGiven: input.method === "CASH" ? changeGiven : null,
      receivedBy: actorId(actor),
      shiftId: await openShiftId(tx, actor),
      note: input.note ?? null,
      occurredAt: now,
    },
  });
  await writeLedger(tx, {
    source: LEDGER_SOURCE_FOR_BILL[before.sourceType],
    direction: "IN",
    method: input.method,
    amount: input.amount,
    taxAmount: proportionalTax(before, input.amount),
    billId: before.id,
    paymentId: payment.id,
    description: `${METHOD_LABEL[input.method]} payment · ${before.customerName}`,
    occurredAt: now,
  });
  const bill = await refreshBill(tx, before.id);
  await audit(tx, actor, "payment.record", "payment", payment.id, {
    after: { billId: bill.id, method: input.method, amount: input.amount, reference: input.reference ?? null },
  });
  if (before.status !== "PAID" && bill.status === "PAID") await onBillPaid(tx, bill, actor);
  await onBillPaymentChanged(tx, bill);
  return { payment, bill, changeGiven };
}

export async function recordCounterPayment(actor: Actor, raw: CounterPaymentInput, idempotencyKey?: string | null) {
  const input = counterPaymentSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "payments.counter", body: input }, async () => {
      const r = await recordPaymentTx(tx, actor, input);
      return { paymentId: r.payment.id, billId: r.bill.id, billStatus: r.bill.status, due: billDue(r.bill), changeGiven: r.changeGiven };
    }),
  );
}

/** E-14: several counter payments (split across cash/card/UPI) in one transaction. */
export async function recordSplitPaymentsTx(
  tx: Tx,
  actor: Actor,
  billId: string,
  parts: Array<{ method: "CASH" | "CARD" | "UPI"; amount: number; reference?: string | null; tendered?: number | null }>,
) {
  let changeGiven = 0;
  let bill: Bill | null = null;
  for (const p of parts) {
    const r = await recordPaymentTx(tx, actor, { billId, ...p });
    changeGiven += r.changeGiven;
    bill = r.bill;
  }
  return { bill: bill ?? (await refreshBill(tx, billId)), changeGiven };
}

// ───────────── online payments (PY-3, PY-7) ─────────────

/** Create a PENDING online payment for the amount due and a gateway order. */
export async function startOnlinePaymentTx(
  tx: Tx,
  actor: Actor,
  billId: string,
  opts: { returnUrl: string; internal?: boolean },
): Promise<{ paymentId: string; redirectUrl: string; amount: number; gateway: string }> {
  const bill = await lockBill(tx, billId);
  if (!opts.internal) {
    if (actor.kind === "USER" && actor.role === "MEMBER") {
      if (bill.memberId !== actor.memberId) throw new DomainError("FORBIDDEN", "Not allowed: this bill belongs to someone else.");
    } else {
      assertCanTakePayment(actor, bill);
    }
  }
  const due = billDue(bill);
  if (due <= 0) throw new DomainError("OVERPAYMENT", "Nothing is due on this bill.");
  const returnUrl = opts.returnUrl.startsWith("/") && !opts.returnUrl.startsWith("//") ? opts.returnUrl : "/";
  const gateway = activeGateway();
  const payment = await tx.payment.create({
    data: {
      billId,
      type: "PAYMENT",
      method: "ONLINE",
      amount: due,
      status: "PENDING",
      gateway: gateway.name,
      receivedBy: actorId(actor),
      returnUrl,
      occurredAt: clock.now(),
    },
  });
  const order = await gateway.createOrder({ paymentId: payment.id, amount: due, description: bill.customerName, returnUrl });
  await tx.payment.update({ where: { id: payment.id }, data: { gatewayOrderId: order.gatewayOrderId } });
  await audit(tx, actor, "payment.online.start", "payment", payment.id, { after: { billId, amount: due, gateway: gateway.name } });
  return { paymentId: payment.id, redirectUrl: order.redirectUrl, amount: due, gateway: gateway.name };
}

export async function startOnlinePayment(actor: Actor, billId: string, returnUrl: string, idempotencyKey?: string | null) {
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "payments.online.start", body: { billId } }, () =>
      startOnlinePaymentTx(tx, actor, billId, { returnUrl }),
    ),
  );
}

/**
 * The one verification path for every gateway (PY-3, PY-7). Idempotent: a duplicate callback for a payment
 * that is no longer PENDING returns the recorded outcome and changes nothing.
 */
export async function verifyOnlinePayment(paymentId: string, payload: Record<string, string>) {
  return withTx(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    if (!locked.length) throw new DomainError("NOT_FOUND", "Payment was not found.");
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.method !== "ONLINE" || payment.type !== "PAYMENT") {
      throw new DomainError("VALIDATION_FAILED", "Only online payments can be verified.");
    }
    const gateway = gatewayByName(payment.gateway);
    const v = gateway.verifyCallback(payload, { gatewayOrderId: payment.gatewayOrderId, paymentId: payment.id });
    if (!v.ok) throw new DomainError("VALIDATION_FAILED", "Payment verification failed: the gateway signature does not match.");
    if (payment.status !== "PENDING") {
      return { paymentId: payment.id, status: payment.status, billId: payment.billId, replayed: true, returnUrl: payment.returnUrl };
    }
    const actor = { ...SYSTEM, name: `gateway:${gateway.name.toLowerCase()}` };
    const now = clock.now();
    if (v.outcome === "FAIL") {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED", gatewayPaymentId: v.gatewayPaymentId, failureReason: "Declined at the payment gateway", occurredAt: now },
      });
      await audit(tx, actor, "payment.online.failed", "payment", payment.id, { after: { status: "FAILED" } });
      return { paymentId: payment.id, status: "FAILED" as const, billId: payment.billId, replayed: false, returnUrl: payment.returnUrl };
    }
    const dup = await tx.payment.findFirst({ where: { gatewayPaymentId: v.gatewayPaymentId, id: { not: payment.id } } });
    if (dup) throw new DomainError("VALIDATION_FAILED", "This gateway payment was already recorded against another payment.");
    const before = await lockBill(tx, payment.billId);
    const due = billDue(before);
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCEEDED", gatewayPaymentId: v.gatewayPaymentId, reference: v.gatewayPaymentId, occurredAt: now },
    });
    await writeLedger(tx, {
      source: LEDGER_SOURCE_FOR_BILL[before.sourceType],
      direction: "IN",
      method: "ONLINE",
      amount: payment.amount,
      taxAmount: proportionalTax(before, payment.amount),
      billId: before.id,
      paymentId: payment.id,
      description: `online payment · ${before.customerName}`,
      occurredAt: now,
    });
    await audit(tx, actor, "payment.online.succeeded", "payment", payment.id, {
      after: { status: "SUCCEEDED", amount: payment.amount, gatewayPaymentId: v.gatewayPaymentId },
    });
    if (payment.amount > due) {
      // The bill changed while the customer was at the gateway (e.g. the order hold expired). Money that is
      // not owed goes straight back — never kept, never silently dropped.
      await refreshBill(tx, before.id);
      await refundTx(tx, actor, before.id, payment.amount - due, { reason: "Paid after the bill was closed or reduced — automatic refund" });
      const bill = await refreshBill(tx, before.id);
      return { paymentId: payment.id, status: "SUCCEEDED" as const, billId: bill.id, replayed: false, refunded: payment.amount - due, returnUrl: payment.returnUrl };
    }
    const bill = await refreshBill(tx, before.id);
    if (before.status !== "PAID" && bill.status === "PAID") await onBillPaid(tx, bill, actor);
    await onBillPaymentChanged(tx, bill);
    return { paymentId: payment.id, status: "SUCCEEDED" as const, billId: bill.id, replayed: false, returnUrl: payment.returnUrl };
  });
}

/** Expire stale PENDING online payments (customer abandoned the gateway page). */
export async function failStalePendingPayments(olderThanMinutes: number, outer?: Tx) {
  return withTx(async (tx) => {
    const cutoff = new Date(clock.now().getTime() - olderThanMinutes * 60_000);
    const res = await tx.payment.updateMany({
      where: { status: "PENDING", method: "ONLINE", occurredAt: { lt: cutoff } },
      data: { status: "FAILED", failureReason: "Abandoned at the payment gateway" },
    });
    return res.count;
  }, outer);
}

// ───────────── refunds (PY-4, PY-5) ─────────────

/**
 * Refund `amount` on a bill inside an existing transaction. Allocated to the newest payments first; online
 * payments are refunded through their gateway, counter payments by `method` (default: the original method).
 * Each refund is a REFUND payment + a negative IN ledger entry under the bill's original source.
 */
export async function refundTx(
  tx: Tx,
  actor: Actor,
  billId: string,
  amount: number,
  opts: { method?: "CASH" | "CARD" | "UPI"; reason: string },
): Promise<{ refunded: number; refunds: Payment[] }> {
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError("VALIDATION_FAILED", "Refund amount must be positive.");
  const bill = await lockBill(tx, billId);
  const refundable = netPaid(bill);
  if (amount > refundable) {
    throw new DomainError(
      "REFUND_EXCEEDS_PAID",
      `A refund of ${formatINR(amount)} is more than the ${formatINR(refundable)} paid on this bill.`,
      { refundable, amount },
    );
  }
  const payments = await tx.payment.findMany({
    where: { billId, type: "PAYMENT", status: "SUCCEEDED" },
    orderBy: { occurredAt: "desc" },
  });
  const refunds: Payment[] = [];
  let remaining = amount;
  const now = clock.now();
  for (const p of payments) {
    if (remaining <= 0) break;
    const already = await tx.payment.aggregate({
      where: { refundOfId: p.id, type: "REFUND", status: "SUCCEEDED" },
      _sum: { amount: true },
    });
    const avail = p.amount - (already._sum.amount ?? 0);
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    let method: PaymentMethod = p.method;
    let reference: string | null = null;
    if (p.method === "ONLINE") {
      if (!p.gatewayPaymentId) throw new Error(`online payment ${p.id} has no gateway id`);
      const r = await gatewayByName(p.gateway).refund({ gatewayPaymentId: p.gatewayPaymentId, amount: take });
      reference = r.gatewayRefundId;
    } else if (opts.method) {
      method = opts.method;
    }
    const refund = await tx.payment.create({
      data: {
        billId,
        type: "REFUND",
        method,
        amount: take,
        status: "SUCCEEDED",
        reference,
        gateway: p.method === "ONLINE" ? p.gateway : null,
        receivedBy: actorId(actor),
        shiftId: await openShiftId(tx, actor),
        refundOfId: p.id,
        note: opts.reason,
        occurredAt: now,
      },
    });
    await writeLedger(tx, {
      source: LEDGER_SOURCE_FOR_BILL[bill.sourceType],
      direction: "IN",
      method,
      amount: -take,
      taxAmount: proportionalTax(bill, -take),
      billId,
      paymentId: refund.id,
      description: `refund (${METHOD_LABEL[method]}) · ${bill.customerName} · ${opts.reason}`,
      occurredAt: now,
    });
    refunds.push(refund);
    remaining -= take;
  }
  if (remaining > 0) throw new Error(`refund allocation left ${remaining} unallocated on bill ${billId}`);
  await onBillPaymentChanged(tx, await refreshBill(tx, billId));
  await audit(tx, actor, "payment.refund", "bill", billId, { after: { amount, refunds: refunds.map((r) => r.id) }, reason: opts.reason });
  return { refunded: amount, refunds };
}

export const refundSchema = z.object({
  billId: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.enum(["CASH", "CARD", "UPI"]).optional(),
  reason: z.string().trim().min(3).max(300),
});

/** Discretionary refund (OWNER/MANAGER only, §3). Rule-driven refunds (cancellations) call refundTx directly. */
export async function issueRefund(actor: Actor, raw: z.infer<typeof refundSchema>, idempotencyKey?: string | null) {
  assertCan(actor, "refunds.issue");
  const input = refundSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "payments.refund", body: input }, async () => {
      const r = await refundTx(tx, actor, input.billId, input.amount, { method: input.method, reason: input.reason });
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: input.billId } });
      return { refunded: r.refunded, billStatus: bill.status, refundIds: r.refunds.map((x) => x.id) };
    }),
  );
}

// ───────────── read side ─────────────

export async function getBill(actor: Actor, billId: string) {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    include: { lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { occurredAt: "asc" } } },
  });
  if (!bill) throw new DomainError("NOT_FOUND", "Bill was not found.");
  assertCanViewBill(actor, bill);
  return { ...bill, due: billDue(bill) };
}

export async function getPaymentForGateway(paymentId: string) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { bill: { include: { lines: true } } } });
  if (!p || p.method !== "ONLINE") throw new DomainError("NOT_FOUND", "Payment was not found.");
  return p;
}
