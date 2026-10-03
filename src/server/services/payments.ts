// Payments (plan §5.10 PY-2…PY-7, E-14, E-23; completion pass §2 "real or absent").
// - Counter payments (cash / card / UPI) are SUCCEEDED when staff record them, only with an enabled method, the
//   proof each method needs (card approval code + last 4, UPI UTR) and an open cash-drawer session.
// - ONLINE payments exist only when the payments.online capability is on (live Razorpay) — or the Test Gateway in
//   tests — and stay PENDING until server-side verification (signed callback, webhook, or a status check).
// - Refunds go back through an enabled method. When nobody can hand the money back right now (e.g. a member
//   cancels online), the refund is recorded as PENDING and paid out later at the desk — never faked as done.
// Every successful payment/refund writes the ledger in the same transaction.
import type { Bill, BillSource, Payment, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { isValidApprovalCode, isValidUtr } from "@/lib/codes";
import { formatINR, roundDiv } from "@/lib/money";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, SYSTEM, type Actor } from "../rbac/actor";
import { assertCan, can, type Capability } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue, lockBill, netPaid, refreshBill } from "./bills";
import { onBillPaid, onBillPaymentChanged } from "./bill-events";
import { assertCapability, isEnabled, type CapabilityName } from "./capabilities";
import { requireDrawer } from "./drawers";
import { activeGateway, gatewayByName, razorpayGateway } from "./gateway";
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

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "cash", CARD: "card", UPI: "UPI", ONLINE: "online", BANK_TRANSFER: "bank transfer" };
const METHOD_CAPABILITY: Partial<Record<PaymentMethod, CapabilityName>> = { CASH: "payments.cash", CARD: "payments.card", UPI: "payments.upi", ONLINE: "payments.online" };
const DRAWER_METHODS: PaymentMethod[] = ["CASH", "CARD", "UPI"];

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
  const a = await tx.attendance.findFirst({ where: { employeeId: actor.employeeId, clockOut: null }, orderBy: { clockIn: "desc" }, select: { id: true } });
  return a?.id ?? null;
}

function proportionalTax(bill: Bill, amount: number): number {
  if (bill.total <= 0 || bill.taxTotal <= 0) return 0;
  const sign = amount < 0 ? -1 : 1;
  return sign * roundDiv(bill.taxTotal * Math.abs(amount), bill.total);
}

// ───────────── tender validation (§2.3, §2.4) ─────────────

/** One counter tender. Card needs the terminal approval code + last 4 digits; UPI needs the 12-character UTR. */
export const tenderSchema = z.object({
  method: z.enum(["CASH", "CARD", "UPI", "BANK_TRANSFER"]),
  amount: z.number().int().positive().optional(),
  reference: z.string().trim().max(100).optional().nullable(),
  tendered: z.number().int().positive().optional().nullable(),
  cardLast4: z.string().trim().optional().nullable(),
  approvalCode: z.string().trim().optional().nullable(),
});
export type Tender = z.infer<typeof tenderSchema>;

async function validateTender(t: Tender, bill: Bill, kind: "payment" | "refund") {
  const cap = METHOD_CAPABILITY[t.method];
  if (cap) await assertCapability(cap);
  if (t.method === "BANK_TRANSFER") {
    if (bill.sourceType !== "INVOICE") throw new DomainError("VALIDATION_FAILED", "Bank transfers are recorded against invoices only.");
    if (!t.reference || t.reference.length < 4) throw new DomainError("VALIDATION_FAILED", "Enter the bank transfer reference (UTR / NEFT / IMPS).");
  }
  if (t.method === "UPI" && (!t.reference || !isValidUtr(t.reference))) {
    throw new DomainError("VALIDATION_FAILED", `Enter the 12-character UPI reference (UTR) from the club's phone before recording this UPI ${kind}.`);
  }
  if (t.method === "CARD") {
    if (!t.approvalCode || !isValidApprovalCode(t.approvalCode)) throw new DomainError("VALIDATION_FAILED", "Enter the card terminal's approval code (4–12 letters or digits).");
    if (kind === "payment" && (!t.cardLast4 || !/^\d{4}$/.test(t.cardLast4))) throw new DomainError("VALIDATION_FAILED", "Enter the last 4 digits of the card.");
  }
  if (t.method !== "CASH" && t.tendered) throw new DomainError("VALIDATION_FAILED", "Cash tendered can only be entered for cash payments.");
}

// ───────────── counter payments ─────────────

export const counterPaymentSchema = tenderSchema.extend({
  billId: z.string().min(1),
  amount: z.number().int().positive(),
  note: z.string().max(200).optional().nullable(),
});
export type CounterPaymentInput = z.infer<typeof counterPaymentSchema>;

/** Record a counter payment inside an existing transaction (sign-up, counter sale, tab settle, desk…). */
export async function recordPaymentTx(tx: Tx, actor: Actor, raw: CounterPaymentInput): Promise<{ payment: Payment; bill: Bill; changeGiven: number }> {
  const input = counterPaymentSchema.parse(raw);
  const before = await lockBill(tx, input.billId);
  assertCanTakePayment(actor, before);
  const due = billDue(before);
  if (input.amount > due) {
    throw new DomainError(
      "OVERPAYMENT",
      due === 0 ? `Nothing is due on this bill (${before.customerName}).` : `A payment of ${formatINR(input.amount)} is more than the ${formatINR(due)} still due on this bill.`,
      { due, amount: input.amount },
    );
  }
  await validateTender(input, before, "payment");
  if (input.method === "CASH" && input.tendered != null && input.tendered < input.amount) {
    throw new DomainError("VALIDATION_FAILED", `Cash tendered (${formatINR(input.tendered)}) is less than the amount (${formatINR(input.amount)}).`);
  }
  const drawerSessionId = DRAWER_METHODS.includes(input.method) ? await requireDrawer(tx, actor) : null;
  const changeGiven = input.method === "CASH" && input.tendered ? input.tendered - input.amount : 0;
  const now = clock.now();
  const payment = await tx.payment.create({
    data: {
      billId: before.id, type: "PAYMENT", method: input.method, amount: input.amount, status: "SUCCEEDED",
      reference: input.method === "CARD" ? (input.approvalCode ?? null) : (input.reference ?? null),
      approvalCode: input.method === "CARD" ? (input.approvalCode ?? null) : null,
      cardLast4: input.method === "CARD" ? (input.cardLast4 ?? null) : null,
      tendered: input.method === "CASH" ? (input.tendered ?? input.amount) : null,
      changeGiven: input.method === "CASH" ? changeGiven : null,
      receivedBy: actorId(actor), shiftId: await openShiftId(tx, actor), drawerSessionId, note: input.note ?? null, occurredAt: now,
    },
  });
  await writeLedger(tx, {
    source: LEDGER_SOURCE_FOR_BILL[before.sourceType], direction: "IN", method: input.method, amount: input.amount,
    taxAmount: proportionalTax(before, input.amount), billId: before.id, paymentId: payment.id,
    description: `${METHOD_LABEL[input.method]} payment · ${before.customerName}`, occurredAt: now,
  });
  const bill = await refreshBill(tx, before.id);
  await audit(tx, actor, "payment.record", "payment", payment.id, {
    after: { billId: bill.id, method: input.method, amount: input.amount, reference: payment.reference, cardLast4: payment.cardLast4 },
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

/** E-14: several counter payments (split across enabled methods) in one transaction. */
export async function recordSplitPaymentsTx(tx: Tx, actor: Actor, billId: string, parts: Array<Tender & { amount: number }>) {
  let changeGiven = 0;
  let bill: Bill | null = null;
  for (const p of parts) {
    const r = await recordPaymentTx(tx, actor, { ...p, billId });
    changeGiven += r.changeGiven;
    bill = r.bill;
  }
  return { bill: bill ?? (await refreshBill(tx, billId)), changeGiven };
}

// ───────────── online payments (PY-3; §2.6) ─────────────

/** Create a PENDING online payment for the amount due and a gateway order. Requires payments.online. */
export async function startOnlinePaymentTx(
  tx: Tx,
  actor: Actor,
  billId: string,
  opts: { returnUrl: string; internal?: boolean },
): Promise<{ paymentId: string; redirectUrl: string; amount: number; gateway: string }> {
  await assertCapability("payments.online");
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
    data: { billId, type: "PAYMENT", method: "ONLINE", amount: due, status: "PENDING", gateway: gateway.name, receivedBy: actorId(actor), returnUrl, occurredAt: clock.now() },
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

type SettleResult = { paymentId: string; status: "SUCCEEDED" | "FAILED" | "PENDING"; billId: string; replayed: boolean; refunded?: number; returnUrl: string | null };

/** The single success/failure path for an online payment (callback, webhook, status check). Idempotent. */
async function settleOnlineTx(tx: Tx, paymentId: string, gatewayPaymentId: string, outcome: "SUCCESS" | "FAIL", source: string): Promise<SettleResult> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
  if (!locked.length) throw new DomainError("NOT_FOUND", "Payment was not found.");
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (payment.status !== "PENDING") return { paymentId: payment.id, status: payment.status, billId: payment.billId, replayed: true, returnUrl: payment.returnUrl };
  const actor = { ...SYSTEM, name: `gateway:${(payment.gateway ?? "").toLowerCase()}:${source}` };
  const now = clock.now();
  if (outcome === "FAIL") {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", gatewayPaymentId, failureReason: "Declined at the payment gateway", occurredAt: now } });
    await audit(tx, actor, "payment.online.failed", "payment", payment.id, { after: { status: "FAILED" } });
    return { paymentId: payment.id, status: "FAILED", billId: payment.billId, replayed: false, returnUrl: payment.returnUrl };
  }
  const dup = await tx.payment.findFirst({ where: { gatewayPaymentId, id: { not: payment.id } } });
  if (dup) throw new DomainError("VALIDATION_FAILED", "This gateway payment was already recorded against another payment.");
  const before = await lockBill(tx, payment.billId);
  const due = billDue(before);
  await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED", gatewayPaymentId, reference: gatewayPaymentId, occurredAt: now } });
  await writeLedger(tx, {
    source: LEDGER_SOURCE_FOR_BILL[before.sourceType], direction: "IN", method: "ONLINE", amount: payment.amount,
    taxAmount: proportionalTax(before, payment.amount), billId: before.id, paymentId: payment.id,
    description: `online payment · ${before.customerName}`, occurredAt: now,
  });
  await audit(tx, actor, "payment.online.succeeded", "payment", payment.id, { after: { status: "SUCCEEDED", amount: payment.amount, gatewayPaymentId } });
  if (payment.amount > due) {
    // D-12: the bill changed while the customer was at the gateway (e.g. the hold expired) — money not owed goes back.
    await refreshBill(tx, before.id);
    await refundTx(tx, actor, before.id, payment.amount - due, { reason: "Paid after the bill was closed or reduced — automatic refund" });
    const bill = await refreshBill(tx, before.id);
    return { paymentId: payment.id, status: "SUCCEEDED", billId: bill.id, replayed: false, refunded: payment.amount - due, returnUrl: payment.returnUrl };
  }
  const bill = await refreshBill(tx, before.id);
  if (before.status !== "PAID" && bill.status === "PAID") await onBillPaid(tx, bill, actor);
  await onBillPaymentChanged(tx, bill);
  return { paymentId: payment.id, status: "SUCCEEDED", billId: bill.id, replayed: false, returnUrl: payment.returnUrl };
}

/** Browser callback (signed). FAIL callbacks are accepted only when the gateway confirms the payment isn't captured. */
export async function verifyOnlinePayment(paymentId: string, payload: Record<string, string>): Promise<SettleResult> {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw new DomainError("NOT_FOUND", "Payment was not found.");
  if (p.method !== "ONLINE" || p.type !== "PAYMENT") throw new DomainError("VALIDATION_FAILED", "Only online payments can be verified.");
  const gateway = gatewayByName(p.gateway);
  const v = gateway.verifyCallback(payload, { gatewayOrderId: p.gatewayOrderId, paymentId: p.id });
  if (!v.ok) throw new DomainError("VALIDATION_FAILED", "Payment verification failed: the gateway signature does not match.");
  if (v.outcome === "FAIL" && gateway.name === "RAZORPAY" && p.status === "PENDING") {
    const live = await razorpayGateway.fetchPayment(v.gatewayPaymentId);
    if (live.order_id !== p.gatewayOrderId) throw new DomainError("VALIDATION_FAILED", "This gateway payment belongs to another order.");
    if (live.status === "captured" || live.status === "authorized") {
      throw new DomainError("VALIDATION_FAILED", "The gateway reports this payment as successful; it will be confirmed automatically.");
    }
  }
  return withTx((tx) => settleOnlineTx(tx, paymentId, v.gatewayPaymentId, v.outcome, "callback"));
}

/** §2.6a: Razorpay webhook — signature over the raw body; payment.captured / payment.failed; idempotent. */
export async function handleRazorpayWebhook(rawBody: string, signature: string | null) {
  if (!razorpayGateway.verifyWebhook(rawBody, signature)) throw new DomainError("FORBIDDEN", "Invalid webhook signature.");
  const event = JSON.parse(rawBody) as { event?: string; payload?: { payment?: { entity?: { id: string; order_id: string; status: string } } } };
  const entity = event.payload?.payment?.entity;
  if (!entity || (event.event !== "payment.captured" && event.event !== "payment.failed")) return { handled: false, reason: `ignored ${event.event ?? "unknown"}` };
  const p = await prisma.payment.findFirst({ where: { gatewayOrderId: entity.order_id, method: "ONLINE", type: "PAYMENT" } });
  if (!p) return { handled: false, reason: "no matching order" };
  const r = await withTx((tx) => settleOnlineTx(tx, p.id, entity.id, event.event === "payment.captured" ? "SUCCESS" : "FAIL", "webhook"));
  return { handled: true, status: r.status, replayed: r.replayed };
}

/**
 * §2.6b: stale PENDING online payments. Razorpay is asked first — a captured payment takes the normal success
 * path (with the D-12 auto-refund if its hold expired); only payments the gateway didn't capture are failed.
 */
export async function failStalePendingPayments(olderThanMinutes: number, outer?: Tx) {
  const cutoff = new Date(clock.now().getTime() - olderThanMinutes * 60_000);
  const stale = await (outer ?? prisma).payment.findMany({ where: { status: "PENDING", method: "ONLINE", type: "PAYMENT", occurredAt: { lt: cutoff } } });
  let failed = 0;
  let captured = 0;
  for (const p of stale) {
    let outcome: { id: string; result: "SUCCESS" | "FAIL" } = { id: p.gatewayPaymentId ?? `abandoned_${p.id}`, result: "FAIL" };
    if (p.gateway === "RAZORPAY" && p.gatewayOrderId) {
      const list = await razorpayGateway.fetchOrderPayments(p.gatewayOrderId);
      const ok = list.find((x) => x.status === "captured");
      if (ok) outcome = { id: ok.id, result: "SUCCESS" };
    }
    const r = await withTx((tx) => settleOnlineTx(tx, p.id, outcome.id, outcome.result, "status-check"), outer);
    if (r.status === "SUCCEEDED") captured++;
    else if (r.status === "FAILED") failed++;
  }
  return { failed, captured };
}

// ───────────── refunds (PY-4, PY-5; §2.7) ─────────────

async function refundedSoFar(tx: Tx, paymentId: string) {
  const r = await tx.payment.aggregate({ where: { refundOfId: paymentId, type: "REFUND", status: { in: ["SUCCEEDED", "PENDING"] } }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

export type RefundOpts = { method?: "CASH" | "CARD" | "UPI" | "BANK_TRANSFER"; reference?: string | null; approvalCode?: string | null; reason: string };

/**
 * Refund `amount` on a bill inside an existing transaction, allocated to the newest payments first.
 * - online originals go back through their gateway (when online payments are available);
 * - otherwise a staff member with an open drawer pays it out now with an enabled method (default: cash for cash
 *   originals; UPI/card need their reference);
 * - if that isn't possible right now, a PENDING refund is created for the desk to pay out (completeRefund).
 */
export async function refundTx(tx: Tx, actor: Actor, billId: string, amount: number, opts: RefundOpts): Promise<{ refunded: number; pending: number; refunds: Payment[] }> {
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError("VALIDATION_FAILED", "Refund amount must be positive.");
  const bill = await lockBill(tx, billId);
  const refundable = netPaid(bill);
  if (amount > refundable) {
    throw new DomainError("REFUND_EXCEEDS_PAID", `A refund of ${formatINR(amount)} is more than the ${formatINR(refundable)} paid on this bill.`, { refundable, amount });
  }
  const payments = await tx.payment.findMany({ where: { billId, type: "PAYMENT", status: "SUCCEEDED" }, orderBy: { occurredAt: "desc" } });
  const refunds: Payment[] = [];
  let remaining = amount;
  let pending = 0;
  const now = clock.now();
  const staffWithDrawer = actor.kind === "USER" ? await tx.cashDrawerSession.findFirst({ where: { userId: actor.userId, closedAt: null } }) : null;
  for (const p of payments) {
    if (remaining <= 0) break;
    const avail = p.amount - (await refundedSoFar(tx, p.id));
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    let method: PaymentMethod | null = null;
    let reference: string | null = null;
    let gateway: string | null = null;
    let drawerSessionId: string | null = null;
    if (p.method === "ONLINE" && p.gatewayPaymentId && (await isEnabled("payments.online"))) {
      const r = await gatewayByName(p.gateway).refund({ gatewayPaymentId: p.gatewayPaymentId, amount: take });
      method = "ONLINE";
      reference = r.gatewayRefundId;
      gateway = p.gateway;
    } else {
      const chosen = opts.method ?? (p.method === "ONLINE" ? undefined : p.method);
      const proofOk =
        chosen === "CASH" ||
        (chosen === "UPI" && !!opts.reference && /^[A-Za-z0-9]{12}$/.test(opts.reference)) ||
        (chosen === "CARD" && !!(opts.approvalCode ?? opts.reference)) ||
        (chosen === "BANK_TRANSFER" && !!opts.reference);
      const methodOn = chosen ? (chosen === "BANK_TRANSFER" ? bill.sourceType === "INVOICE" : await isEnabled(METHOD_CAPABILITY[chosen]!)) : false;
      const needsDrawer = chosen ? DRAWER_METHODS.includes(chosen) : false;
      if (chosen && proofOk && methodOn && (!needsDrawer || staffWithDrawer)) {
        method = chosen;
        reference = chosen === "CARD" ? (opts.approvalCode ?? opts.reference ?? null) : (opts.reference ?? null);
        drawerSessionId = needsDrawer ? staffWithDrawer!.id : null;
      }
    }
    const status = method ? "SUCCEEDED" : "PENDING";
    const refund = await tx.payment.create({
      data: {
        billId, type: "REFUND", method: method ?? (p.method === "ONLINE" ? "CASH" : p.method), amount: take, status,
        reference, gateway, approvalCode: method === "CARD" ? reference : null, receivedBy: actorId(actor),
        shiftId: await openShiftId(tx, actor), drawerSessionId, refundOfId: p.id,
        note: status === "PENDING" ? `To be paid at the desk · ${opts.reason}` : opts.reason, occurredAt: now,
      },
    });
    if (status === "SUCCEEDED") {
      await writeLedger(tx, {
        source: LEDGER_SOURCE_FOR_BILL[bill.sourceType], direction: "IN", method: method!, amount: -take, taxAmount: proportionalTax(bill, -take),
        billId, paymentId: refund.id, description: `refund (${METHOD_LABEL[method!]}) · ${bill.customerName} · ${opts.reason}`, occurredAt: now,
      });
    } else {
      pending += take;
    }
    refunds.push(refund);
    remaining -= take;
  }
  if (remaining > 0) throw new Error(`refund allocation left ${remaining} unallocated on bill ${billId}`);
  await onBillPaymentChanged(tx, await refreshBill(tx, billId));
  await audit(tx, actor, pending ? "payment.refund.pending" : "payment.refund", "bill", billId, { after: { amount, pending, refunds: refunds.map((r) => r.id) }, reason: opts.reason });
  return { refunded: amount - pending, pending, refunds };
}

export const completeRefundSchema = tenderSchema.pick({ method: true, reference: true, approvalCode: true });

/** Pay out a PENDING refund at the counter (needs the bill's capability, an enabled method and an open drawer). */
export async function completeRefund(actor: Actor, refundId: string, raw: z.infer<typeof completeRefundSchema>) {
  const input = completeRefundSchema.parse(raw);
  return withTx(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${refundId} FOR UPDATE`;
    if (!locked.length) throw new DomainError("NOT_FOUND", "Refund was not found.");
    const r = await tx.payment.findUniqueOrThrow({ where: { id: refundId } });
    if (r.type !== "REFUND" || r.status !== "PENDING") throw new DomainError("VALIDATION_FAILED", "This refund is not waiting to be paid.");
    const bill = await lockBill(tx, r.billId);
    assertCanTakePayment(actor, bill);
    await validateTender({ method: input.method, reference: input.reference, approvalCode: input.approvalCode }, bill, "refund");
    const drawerSessionId = DRAWER_METHODS.includes(input.method) ? await requireDrawer(tx, actor) : null;
    const now = clock.now();
    const reference = input.method === "CARD" ? (input.approvalCode ?? null) : (input.reference ?? null);
    await tx.payment.update({ where: { id: r.id }, data: { status: "SUCCEEDED", method: input.method, reference, drawerSessionId, receivedBy: actorId(actor), occurredAt: now } });
    await writeLedger(tx, {
      source: LEDGER_SOURCE_FOR_BILL[bill.sourceType], direction: "IN", method: input.method, amount: -r.amount, taxAmount: proportionalTax(bill, -r.amount),
      billId: bill.id, paymentId: r.id, description: `refund (${METHOD_LABEL[input.method]}) · ${bill.customerName} · ${r.note ?? ""}`, occurredAt: now,
    });
    const after = await refreshBill(tx, bill.id);
    await onBillPaymentChanged(tx, after);
    await audit(tx, actor, "payment.refund.complete", "payment", r.id, { after: { method: input.method, amount: r.amount, reference } });
    return { refundId: r.id, amount: r.amount, method: input.method };
  });
}

export async function listPendingRefunds(actor: Actor) {
  if (!can(actor, "bookings.any") && !can(actor, "shop.counter") && !can(actor, "bar.operate") && !can(actor, "invoices")) {
    throw new DomainError("FORBIDDEN", "Not allowed: you cannot see refunds.");
  }
  const rows = await prisma.payment.findMany({ where: { type: "REFUND", status: "PENDING" }, include: { bill: true }, orderBy: { occurredAt: "asc" }, take: 200 });
  return rows
    .filter((r) => actor.kind === "SYSTEM" || can(actor, BILL_CAPABILITY[r.bill.sourceType]))
    .map((r) => ({ id: r.id, amount: r.amount, billId: r.billId, sourceType: r.bill.sourceType, customer: r.bill.customerName, memberId: r.bill.memberId, note: r.note, since: r.occurredAt }));
}

export const refundSchema = z.object({
  billId: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.enum(["CASH", "CARD", "UPI", "BANK_TRANSFER"]).optional(),
  reference: z.string().trim().max(100).optional(),
  approvalCode: z.string().trim().max(20).optional(),
  reason: z.string().trim().min(3).max(300),
});

/** Discretionary refund (OWNER/MANAGER only, §3). Rule-driven refunds (cancellations) call refundTx directly. */
export async function issueRefund(actor: Actor, raw: z.infer<typeof refundSchema>, idempotencyKey?: string | null) {
  assertCan(actor, "refunds.issue");
  const input = refundSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "payments.refund", body: input }, async () => {
      const r = await refundTx(tx, actor, input.billId, input.amount, input);
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: input.billId } });
      return { refunded: r.refunded, pending: r.pending, billStatus: bill.status, refundIds: r.refunds.map((x) => x.id) };
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
