// v3 §5.2 refund workflow: REQUESTED → APPROVED → COMPLETED, with REJECTED, FAILED and CANCELLED as side exits.
// RF-1 who may ask · RF-2 amount ≤ refundable + reason category · RF-3 approval (policy refunds are created approved;
// Manager up to `refund_manager_limit`, Owner above; never your own) · RF-4 money goes back the way it came (gateway
// when online payments are on, otherwise the desk pays out with proof: UPI UTR, card reversal reference, or cash from
// an open drawer) · RF-5 completion writes REFUND payments + ledger in one transaction and tells the customer ·
// RF-7 every transition is audited. Money only moves in payments.ts (refundTx / completeRefund).
import type { Bill } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { lockBill, netPaid } from "./bills";
import { idempotent } from "./idempotency";
import { notify } from "./notifications";
import { BILL_CAPABILITY, completeRefund, completeRefundSchema, refundTx } from "./payments";
import { createRequestedTx, nextRefundCode, notifyRefund, REFUND_REASONS, refundableNow, type RefundReason } from "./refund-records";
import { getSettings } from "./settings";
import { refundClubCancellationTx } from "./closures";

function staffCanSeeBill(actor: Actor, bill: Bill): boolean {
  return can(actor, BILL_CAPABILITY[bill.sourceType]) || can(actor, "members.view") || can(actor, "finance.reports");
}

export const refundRequestSchema = z.object({
  billId: z.string().min(1),
  amount: z.number().int().positive(),
  reason: z.enum(REFUND_REASONS),
  note: z.string().trim().min(3, "Add a note (at least 3 characters).").max(300),
});

/** RF-1 (staff): desk, shop, bar, manager and owner may ask for a refund on any bill they can see. */
export async function requestRefund(actor: Actor, raw: z.infer<typeof refundRequestSchema>, idempotencyKey?: string | null) {
  assertCan(actor, "refunds.request");
  const input = refundRequestSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "refunds.request", body: input }, async () => {
      const bill = await tx.bill.findUnique({ where: { id: input.billId } });
      if (!bill) throw new DomainError("NOT_FOUND", "Bill was not found.");
      if (!staffCanSeeBill(actor, bill)) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this bill.");
      const r = await createRequestedTx(tx, actor, input);
      return { id: r.id, code: r.code, status: r.status, amount: r.amount };
    }),
  );
}

/** For other services (e.g. a membership cancelled with a refund): the request waits for approval like any other. */
export async function requestRefundTx(tx: Tx, actor: Actor, input: { billId: string; amount: number; reason: RefundReason; note: string }) {
  return createRequestedTx(tx, actor, input);
}

/**
 * RF-1 (members): only refund-eligible items — a booking cancelled by the club or cancelled within policy, or an
 * online order cancelled before handover — for the money still refundable on it. These are policy refunds (RF-3).
 */
export async function eligibleMemberRefund(tx: Tx | typeof prisma, memberId: string, bill: Bill): Promise<{ reason: RefundReason; policy: string } | null> {
  if (bill.memberId !== memberId) return null;
  if (bill.sourceType === "BOOKING") {
    const b = await tx.booking.findFirst({ where: { billId: bill.id }, include: { reservation: true } });
    if (!b) return null;
    if (b.status === "CANCELLED_BY_CLUB") return { reason: "CLUB_CANCELLATION", policy: "CC-5" };
    if (b.status === "CANCELLED" && b.cancelledAt) {
      const s = await getSettings(tx as Tx);
      const hoursBefore = (b.reservation.startAt.getTime() - b.cancelledAt.getTime()) / 3_600_000;
      if (hoursBefore >= s.cancel_full_refund_hours) return { reason: "POLICY_CANCELLATION", policy: "BK-7" };
    }
    return null;
  }
  if (bill.sourceType === "SHOP_ORDER") {
    const o = await tx.shopOrder.findFirst({ where: { billId: bill.id } });
    if (o?.status === "CANCELLED") return { reason: "POLICY_CANCELLATION", policy: "ORDER_CANCELLED_BEFORE_HANDOVER" };
  }
  return null;
}

export async function requestRefundAsMember(actor: Actor, raw: { billId: string; note?: string }) {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Only members can ask for a refund here.");
  const memberId = actor.memberId;
  return withTx(async (tx) => {
    const bill = await lockBill(tx, raw.billId);
    if (bill.memberId !== memberId) throw new DomainError("FORBIDDEN", "Not allowed: this bill belongs to someone else.");
    // A booking the club cancelled has its own choice (CC-5): refund it through that, so the choice is recorded.
    const cc = await tx.clubCancellation.findFirst({ where: { billId: bill.id, status: "PENDING_CHOICE" } });
    if (cc) return { ...(await refundClubCancellationTx(tx, actor, cc.id)), code: null, pending: 0 };
    const eligible = await eligibleMemberRefund(tx, memberId, bill);
    if (!eligible) throw new DomainError("REFUND_NOT_ELIGIBLE", "This item can't be refunded from the portal. Please ask the club.");
    const amount = await refundableNow(tx, bill);
    if (amount <= 0) throw new DomainError("REFUND_NOT_ELIGIBLE", "Nothing is left to refund on this item.");
    const r = await refundTx(tx, actor, bill.id, amount, { reason: raw.note?.trim() || "Asked for by the member", category: eligible.reason, policy: eligible.policy, deskLater: true });
    const req = await tx.refundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
    return { id: req.id, code: req.code, status: req.status, amount: req.amount, pending: r.pending };
  });
}

async function lockRequest(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM refund_requests WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Refund request was not found.");
  return tx.refundRequest.findUniqueOrThrow({ where: { id } });
}

/** RF-3: Manager up to the limit, Owner above it; nobody decides their own request. */
async function assertMayDecide(tx: Tx, actor: Actor, r: { amount: number; requestedBy: string | null }) {
  assertCan(actor, "refunds.approve");
  if (actor.kind === "USER" && r.requestedBy === actor.userId) throw new DomainError("FORBIDDEN", "Not allowed: you can't approve or reject your own refund request.");
  const s = await getSettings(tx);
  if (actor.kind === "USER" && actor.role !== "OWNER" && r.amount > s.refund_manager_limit) {
    throw new DomainError("FORBIDDEN", `Not allowed: refunds above ${formatINR(s.refund_manager_limit)} need the Owner's approval.`, { limit: s.refund_manager_limit });
  }
}

/**
 * Approve: the refund is prepared the way the money came in. Online payments go straight back through the gateway
 * when online payments are on; everything else waits at the desk ("Ready to pay out"). If the gateway refuses, the
 * request is FAILED (with the reason) and can be paid at the desk instead.
 */
export async function approveRefund(actor: Actor, id: string, note?: string) {
  try {
    await withTx(async (tx) => {
      const r = await lockRequest(tx, id);
      if (r.status !== "REQUESTED") throw new DomainError("ORDER_STATE_INVALID", `This request is already ${r.status.toLowerCase()}.`);
      await assertMayDecide(tx, actor, r);
      const bill = await lockBill(tx, r.billId);
      if (r.amount > netPaid(bill)) {
        throw new DomainError("REFUND_EXCEEDS_PAID", `Only ${formatINR(netPaid(bill))} can still be refunded on this bill; reject this request and ask again.`, { refundable: netPaid(bill) });
      }
      await tx.refundRequest.update({ where: { id }, data: { status: "APPROVED", decidedBy: actorId(actor), decidedAt: clock.now(), decisionNote: note ?? null } });
      await audit(tx, actor, "refund_request.approved", "refund_request", id, { before: { status: "REQUESTED" }, after: { status: "APPROVED" }, reason: note ?? null });
      await refundTx(tx, actor, r.billId, r.amount, { reason: r.note, requestId: id, deskLater: true });
    });
  } catch (e) {
    if (!(e instanceof DomainError && e.code === "GATEWAY_REFUND_FAILED")) throw e;
    // The gateway refused and the transaction rolled back: record the decision and the failure.
    await withTx(async (tx) => {
      const r = await lockRequest(tx, id);
      if (r.status !== "REQUESTED") return;
      await tx.refundRequest.update({ where: { id }, data: { status: "FAILED", decidedBy: actorId(actor), decidedAt: clock.now(), decisionNote: note ?? null, failureReason: e.message } });
      await audit(tx, actor, "refund_request.failed", "refund_request", id, { before: { status: "REQUESTED" }, after: { status: "FAILED" }, reason: e.message });
    });
  }
  return getRefundRequest(actor, id);
}

export async function rejectRefund(actor: Actor, id: string, note: string) {
  const reason = z.string().trim().min(3, "Say why the refund is rejected.").max(300).parse(note);
  return withTx(async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status !== "REQUESTED") throw new DomainError("ORDER_STATE_INVALID", `This request is already ${r.status.toLowerCase()}.`);
    await assertMayDecide(tx, actor, r);
    await tx.refundRequest.update({ where: { id }, data: { status: "REJECTED", decidedBy: actorId(actor), decidedAt: clock.now(), decisionNote: reason } });
    await audit(tx, actor, "refund_request.rejected", "refund_request", id, { before: { status: "REQUESTED" }, after: { status: "REJECTED" }, reason });
    if (r.requestedBy) {
      await notify(tx, { userIds: [r.requestedBy], type: "REFUND_REJECTED", title: `Refund ${r.code} rejected`, body: `${formatINR(r.amount)} · ${reason}`, link: "/app/refunds", dedupeKey: `refund-rejected:${r.id}` });
    }
    // The member whose money it is hears it too, with the reason.
    await notifyRefund(tx, actor, id, "REJECTED");
    return { id, status: "REJECTED" };
  });
}

/** The requester (or an approver) withdraws a request that hasn't been decided. */
export async function cancelRefundRequest(actor: Actor, id: string) {
  return withTx(async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status !== "REQUESTED") throw new DomainError("ORDER_STATE_INVALID", `Only a request waiting for approval can be withdrawn; this one is ${r.status.toLowerCase()}.`);
    const own = actor.kind === "USER" && r.requestedBy === actor.userId;
    if (!own && !can(actor, "refunds.approve")) throw new DomainError("FORBIDDEN", "Not allowed: only the person who asked, or a manager, can withdraw it.");
    await tx.refundRequest.update({ where: { id }, data: { status: "CANCELLED", decidedBy: actorId(actor), decidedAt: clock.now() } });
    await audit(tx, actor, "refund_request.cancelled", "refund_request", id, { before: { status: "REQUESTED" }, after: { status: "CANCELLED" } });
    return { id, status: "CANCELLED" };
  });
}

/**
 * RF-4/RF-5: the desk pays out an approved request (UPI with the outgoing UTR, card with the reversal reference,
 * cash from an open drawer). Every waiting payment of the request is paid; the request completes with the last one.
 */
export async function payOutRefund(actor: Actor, id: string, raw: z.infer<typeof completeRefundSchema>) {
  const r = await prisma.refundRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("NOT_FOUND", "Refund request was not found.");
  if (r.status !== "APPROVED") throw new DomainError("ORDER_STATE_INVALID", `This refund is ${r.status.toLowerCase()}, not ready to pay out.`);
  const waiting = await prisma.payment.findMany({ where: { refundRequestId: id, type: "REFUND", status: "PENDING" }, orderBy: { occurredAt: "asc" } });
  if (!waiting.length) throw new DomainError("ORDER_STATE_INVALID", "Nothing is waiting to be paid out on this refund.");
  for (const p of waiting) await completeRefund(actor, p.id, raw);
  return getRefundRequest(actor, id);
}

/** After a gateway failure: a new approved request for the same money, paid at the desk. */
export async function retryAtDesk(actor: Actor, id: string) {
  assertCan(actor, "refunds.approve");
  return withTx(async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status !== "FAILED") throw new DomainError("ORDER_STATE_INVALID", "Only a failed refund can be retried at the desk.");
    const again = await tx.refundRequest.create({
      data: {
        code: await nextRefundCode(tx), billId: r.billId, amount: r.amount, reason: r.reason, note: r.note, status: "APPROVED",
        autoApproved: r.autoApproved, policy: r.policy, requestedVia: r.requestedVia, requestedBy: r.requestedBy,
        decidedBy: r.decidedBy ?? actorId(actor), decidedAt: clock.now(), decisionNote: `Retry of ${r.code} at the desk`, retryOfId: r.id,
      },
    });
    await audit(tx, actor, "refund_request.retry_at_desk", "refund_request", again.id, { after: { retryOf: r.code, amount: r.amount } });
    await refundTx(tx, actor, r.billId, r.amount, { reason: r.note, requestId: again.id, deskLater: true, noGateway: true });
    return { id: again.id, code: again.code, status: "APPROVED" };
  });
}

export async function getRefundRequest(actor: Actor, id: string) {
  const r = await prisma.refundRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("NOT_FOUND", "Refund request was not found.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
  const isOwnMember = actor.kind === "USER" && actor.role === "MEMBER" && bill.memberId === actor.memberId;
  if (!isOwnMember && !(actor.kind === "SYSTEM" || staffCanSeeBill(actor, bill))) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this refund.");
  const payments = await prisma.payment.findMany({ where: { refundRequestId: id }, orderBy: { occurredAt: "asc" }, select: { id: true, method: true, amount: true, status: true, reference: true, occurredAt: true } });
  const original = await prisma.payment.findMany({ where: { billId: r.billId, type: "PAYMENT", status: "SUCCEEDED" }, select: { method: true } });
  return { ...r, customer: bill.customerName, billSource: bill.sourceType, payments, originalMethods: [...new Set(original.map((p) => p.method))] };
}

