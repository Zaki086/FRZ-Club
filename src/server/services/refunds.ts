// v3 §5.2 refund workflow: REQUESTED → APPROVED → COMPLETED, with REJECTED, FAILED and CANCELLED as side exits.
// RF-1 who may ask · RF-2 amount ≤ refundable + reason category · RF-3 approval (policy refunds are created approved;
// Manager up to `refund_manager_limit`, Owner above; never your own) · RF-4 money goes back the way it came (gateway
// when online payments are on, otherwise the desk pays out with proof: UPI UTR, card reversal reference, or cash from
// an open drawer) · RF-5 completion writes REFUND payments + ledger in one transaction and tells the customer ·
// RF-7 every transition is audited. Money only moves in payments.ts (refundTx / completeRefund).
// v4 §3: RF-8 an approved refund whose money waits at the desk is READY_TO_COLLECT with a signed collection QR ·
// RF-9 the desk finds it (refund QR, member card, name/phone/code), checks the person (member photo + "Identity
// checked"; guests by phone + original booking/order code) and pays it from the open drawer in one transaction ·
// RF-10 unclaimed refunds never expire: reminders at 3 and 7 days, then every 14 days (max 4), and they are a
// liability in "What we owe" · RF-11 several (partial) refunds per bill, the remaining refundable amount shown.
import type { Bill } from "@prisma/client";
import { z } from "zod";
import { clearableContact, mobilePhone } from "@/lib/validation/contact";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { verifyMemberCardPayload } from "@/lib/qr";
import { DAY } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, SYSTEM, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { BILL_WHAT, lockBill, netPaid } from "./bills";
import { idempotent } from "./idempotency";
import { notify } from "./notifications";
import { BILL_CAPABILITY, completeRefund, completeRefundSchema, refundTx } from "./payments";
import {
  billSourceCode, createRequestedTx, describeBill, METHOD_WORDS, nextRefundCode, notifyRefund, REFUND_REASON_LABEL, REFUND_REASONS, refundableNow,
  type RefundReason,
} from "./refund-records";
import { isRefundCollectToken, refundCollectToken, verifyRefundCollectToken } from "./refund-qr";
import { isReceiptToken, verifyReceiptToken } from "./receipt-qr";
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
 * online order cancelled before handover — for the money still refundable on it.
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

/** The members whose refunds a member may see and ask for: themselves and (existing guardian rule) their Juniors. */
async function familyOf(db: Tx | typeof prisma, memberId: string): Promise<string[]> {
  const juniors = await db.member.findMany({ where: { guardianMemberId: memberId }, select: { id: true } });
  return [memberId, ...juniors.map((j) => j.id)];
}

function memberActor(actor: Actor): string {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Only members can ask for a refund here.");
  return actor.memberId;
}

export const memberRefundSchema = z.object({
  billId: z.string().min(1),
  note: z.string().trim().max(300).optional(),
  /** RF-11: part of what is left (default: all of it). */
  amount: z.number().int().positive().optional(),
});

/**
 * v4 §3.2/§3.6: a member (or a Junior's guardian) asks from the portal for an eligible item. The request waits for a
 * manager like any other (approvers are told; the member gets a confirmation). A booking the club cancelled has its
 * own choice (CC-5): it is refunded through that, so the choice is recorded, and is approved at once.
 */
export async function requestRefundAsMember(actor: Actor, raw: z.infer<typeof memberRefundSchema>) {
  const me = memberActor(actor);
  const input = memberRefundSchema.parse(raw);
  return withTx(async (tx) => {
    const bill = await lockBill(tx, input.billId);
    if (!bill.memberId || !(await familyOf(tx, me)).includes(bill.memberId)) throw new DomainError("FORBIDDEN", "Not allowed: this bill belongs to someone else.");
    const cc = await tx.clubCancellation.findFirst({ where: { billId: bill.id, status: "PENDING_CHOICE" } });
    if (cc) return { ...(await refundClubCancellationTx(tx, actor, cc.id)), code: null, pending: 0 };
    const eligible = await eligibleMemberRefund(tx, bill.memberId, bill);
    if (!eligible) throw new DomainError("REFUND_NOT_ELIGIBLE", "This item can't be refunded from the portal. Please ask the club.");
    const left = await refundableNow(tx, bill);
    if (left <= 0) throw new DomainError("REFUND_NOT_ELIGIBLE", "Nothing is left to refund on this item.");
    const amount = input.amount ?? left;
    if (amount > left) throw new DomainError("REFUND_EXCEEDS_PAID", `You can ask for up to ${formatINR(left)} on this item.`, { refundable: left, amount });
    const req = await createRequestedTx(tx, actor, { billId: bill.id, amount, reason: eligible.reason, note: input.note?.trim() || "Asked for by the member", policy: eligible.policy });
    return { id: req.id, code: req.code, status: req.status, amount: req.amount, pending: 0 };
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
 * when online payments are on; everything else waits at the desk — READY_TO_COLLECT (RF-8). If the gateway refuses,
 * the request is FAILED (with the reason) and can be paid at the desk instead.
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
    // Staff who asked hear it in the app; a member who asked hears it with everyone else below.
    if (r.requestedBy && r.requestedVia === "STAFF") {
      await notify(tx, { userIds: [r.requestedBy], type: "REFUND_REJECTED", title: `Refund ${r.code} rejected`, body: `${formatINR(r.amount)} · ${reason}`, link: `/app/refunds/${r.id}`, dedupeKey: `refund-rejected:${r.id}` });
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

// ───────────── RF-9: paying out at the desk ─────────────

// v6 WI-5: an anonymous walk-in sale (no person on the bill) is proven by its receipt — the code typed in
// (RECEIPT_CODE) or the signed receipt QR scanned (RECEIPT_QR).
export const IDENTITY_METHODS = ["REFUND_QR", "MEMBER_CARD", "SEARCH", "GUEST_PHONE_CODE", "RECEIPT_QR", "RECEIPT_CODE"] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];

export const payOutSchema = completeRefundSchema.extend({
  /** "Identity checked": the person in front of the desk is the member on screen (photo), or the guest below. */
  identityChecked: z.boolean().optional(),
  /** How the refund was found: refund QR, member card, or a search. */
  via: z.enum(IDENTITY_METHODS).optional(),
  /** Guests: the phone number they booked/ordered with and the original booking/order code. */
  guestPhone: clearableContact(mobilePhone), // v5 CV-1: the shared mobile validator
  originalCode: z.string().trim().max(40).optional().nullable(),
  /** v6 WI-5: the scanned receipt QR (`RC1.…`) of the sale — proves the receipt in place of typing its code. */
  receiptToken: z.string().trim().max(200).optional().nullable(),
});
export type PayOutInput = z.infer<typeof payOutSchema>;

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

/** RF-9: a guest proves who they are with the phone they gave us and the code of what they paid for. */
async function verifyGuestCollector(tx: Tx, bill: Bill, phone: string | null | undefined, code: string | null | undefined) {
  const expectedCode = await billSourceCode(tx, bill);
  const guest = bill.guestId ? await tx.guest.findUnique({ where: { id: bill.guestId }, select: { phone: true } }) : null;
  if (expectedCode && (code ?? "").trim().toUpperCase() !== expectedCode.toUpperCase()) {
    throw new DomainError("IDENTITY_NOT_CHECKED", `Ask the guest for the original ${BILL_WHAT[bill.sourceType]} code and type it in: the code entered doesn't match this refund.`, { needs: "originalCode" });
  }
  if (guest?.phone && digits(phone) !== digits(guest.phone)) {
    throw new DomainError("IDENTITY_NOT_CHECKED", "Ask the guest for the phone number they used: the number entered doesn't match this refund.", { needs: "guestPhone" });
  }
}

/**
 * RF-4/RF-5/RF-9: the desk pays out an approved request — cash from the open drawer (DRAWER records the CASH_REFUND
 * movement and refuses with INSUFFICIENT_CASH_IN_DRAWER), or UPI/card with their proof when those are on. The person
 * must be checked first ("Identity checked", server-enforced). Every waiting payment of the request is paid in one
 * transaction: REFUND payments + negative ledger entries + drawer movements → COMPLETED (COLLECTED).
 */
export async function payOutRefund(actor: Actor, id: string, raw: PayOutInput) {
  const input = payOutSchema.parse(raw);
  await withTx(async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status !== "APPROVED") throw new DomainError("ORDER_STATE_INVALID", `This refund is ${r.status.toLowerCase()}, not ready to pay out.`);
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: r.billId } });
    if (actor.kind !== "SYSTEM") assertCan(actor, BILL_CAPABILITY[bill.sourceType]);
    const waiting = await tx.payment.findMany({ where: { refundRequestId: id, type: "REFUND", status: "PENDING" }, orderBy: { occurredAt: "asc" } });
    if (!waiting.length) throw new DomainError("ORDER_STATE_INVALID", "Nothing is waiting to be paid out on this refund.");
    if (!input.identityChecked) {
      throw new DomainError("IDENTITY_NOT_CHECKED", "Check who is collecting first: compare them with the photo on screen (guests: phone and original code), then tick “Identity checked”.");
    }
    let method: IdentityMethod = input.via ?? "SEARCH";
    if (!bill.memberId) {
      // v6 WI-5: a scanned receipt QR of this very bill stands in for the typed receipt/original code.
      const scanned = input.receiptToken ? verifyReceiptToken(input.receiptToken) : null;
      if (input.receiptToken && scanned !== bill.id) throw new DomainError("IDENTITY_NOT_CHECKED", "That receipt QR is not this sale's receipt. Scan the customer's receipt or type its code.", { needs: "originalCode" });
      const code = scanned ? await billSourceCode(tx, bill) : input.originalCode;
      await verifyGuestCollector(tx, bill, input.guestPhone, code);
      method = bill.customerKind === "WALK_IN" ? (scanned ? "RECEIPT_QR" : "RECEIPT_CODE") : "GUEST_PHONE_CODE";
    }
    await tx.refundRequest.update({ where: { id }, data: { identityCheckedBy: actorId(actor), identityCheckedAt: clock.now(), identityMethod: method } });
    await audit(tx, actor, "refund_request.identity_checked", "refund_request", id, { after: { method, amount: waiting.reduce((a, p) => a + p.amount, 0) } });
    const tender = { method: input.method, reference: input.reference, approvalCode: input.approvalCode };
    for (const p of waiting) await completeRefund(actor, p.id, tender, tx);
  });
  return getRefundRequest(actor, id);
}

/** For the old per-payment pay-out route: the same identity rule, then the payment is completed. */
export async function payOutRefundPayment(actor: Actor, paymentId: string, raw: PayOutInput) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { refundRequestId: true } });
  if (!p) throw new DomainError("NOT_FOUND", "Refund was not found.");
  if (p.refundRequestId) return payOutRefund(actor, p.refundRequestId, raw);
  const input = payOutSchema.parse(raw);
  if (!input.identityChecked) throw new DomainError("IDENTITY_NOT_CHECKED", "Check who is collecting first, then tick “Identity checked”.");
  return completeRefund(actor, paymentId, { method: input.method, reference: input.reference, approvalCode: input.approvalCode });
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

// ───────────── RF-9: finding a refund to pay out ─────────────

export type CollectableRefund = {
  id: string; code: string; status: string; collectStatus: string | null; amount: number; toCollect: number; readyAt: Date | null;
  what: string; billId: string; customer: string; reason: string;
  member: { id: string; name: string; memberCode: string; phone: string; photoUrl: string | null; guardianName: string | null } | null;
  /** Guests: what the desk must ask for (never shown: the guest says it). v6 WI-5: `walkIn` — an anonymous walk-in
   *  sale, proven by its receipt (code or QR) alone. */
  guest: { needsPhone: boolean; needsCode: boolean; codeLabel: string; walkIn?: boolean } | null;
};

async function collectable(db: Tx | typeof prisma, ids: string[]): Promise<CollectableRefund[]> {
  if (!ids.length) return [];
  const rows = await db.refundRequest.findMany({ where: { id: { in: ids } }, orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }] });
  const out: CollectableRefund[] = [];
  for (const r of rows) {
    const bill = await db.bill.findUniqueOrThrow({ where: { id: r.billId } });
    const pending = await db.payment.aggregate({ where: { refundRequestId: r.id, type: "REFUND", status: "PENDING" }, _sum: { amount: true } });
    const m = bill.memberId ? await db.member.findUnique({ where: { id: bill.memberId }, select: { id: true, name: true, memberCode: true, phone: true, photoUrl: true, guardianMemberId: true, guardianName: true } }) : null;
    const guardian = m?.guardianMemberId ? await db.member.findUnique({ where: { id: m.guardianMemberId }, select: { name: true } }) : null;
    const guest = !m ? (bill.guestId ? await db.guest.findUnique({ where: { id: bill.guestId }, select: { phone: true } }) : null) : null;
    out.push({
      id: r.id, code: r.code, status: r.status, collectStatus: r.collectStatus, amount: r.amount, toCollect: pending._sum.amount ?? 0, readyAt: r.readyAt,
      what: await describeBill(db as Tx, bill), billId: bill.id, customer: bill.customerName, reason: REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason,
      member: m ? { id: m.id, name: m.name, memberCode: m.memberCode, phone: m.phone, photoUrl: m.photoUrl, guardianName: guardian?.name ?? m.guardianName ?? null } : null,
      guest: m ? null : {
        needsPhone: !!guest?.phone, needsCode: !!(await billSourceCode(db as Tx, bill)),
        codeLabel: bill.customerKind === "WALK_IN" ? "receipt code" : `${BILL_WHAT[bill.sourceType]} code`,
        // `walkIn` only on anonymous walk-in sales: every other refund keeps the v4 shape.
        ...(bill.customerKind === "WALK_IN" ? { walkIn: true } : {}),
      },
    });
  }
  return out;
}

function assertDeskRefunds(actor: Actor) {
  if (!(["refunds.request", "refunds.approve"] as const).some((c) => can(actor, c))) throw new DomainError("FORBIDDEN", "Not allowed: you cannot pay out refunds.");
}

const READY_SQL_LIMIT = 20;

/**
 * RF-9 step 1: what is waiting for the person at the desk — from a scanned refund QR (`RF1.…`), a member card
 * (`CC1.…`: that member's and their Juniors' refunds) or a search by name, phone, member code, refund code or the
 * original booking/order code. Only refunds on bills this staff member may take money for.
 */
export async function findCollectableRefunds(actor: Actor, text: string): Promise<{ via: IdentityMethod; refunds: CollectableRefund[] }> {
  assertDeskRefunds(actor);
  const t = String(text ?? "").trim().slice(0, 200);
  let via: IdentityMethod = "SEARCH";
  let ids: string[] = [];
  if (isRefundCollectToken(t)) {
    const id = verifyRefundCollectToken(t);
    if (!id) throw new DomainError("INVALID_REFUND_QR", "This refund QR is not valid (it may have been altered). Search by name, phone or refund code instead.");
    via = "REFUND_QR";
    ids = [id];
  } else if (isReceiptToken(t)) {
    // v6 WI-5: the receipt QR of a sale — the refunds waiting on that bill (an anonymous walk-in has nothing else).
    const billId = verifyReceiptToken(t);
    if (!billId) throw new DomainError("INVALID_REFUND_QR", "This receipt QR is not valid (it may have been altered). Type the receipt code instead.");
    via = "RECEIPT_QR";
    ids = (await prisma.refundRequest.findMany({
      where: { billId, status: "APPROVED", collectStatus: "READY_TO_COLLECT" }, orderBy: { readyAt: "asc" }, take: READY_SQL_LIMIT, select: { id: true },
    })).map((r) => r.id);
  } else if (t.startsWith("CC1.")) {
    const memberId = verifyMemberCardPayload(t);
    if (!memberId) throw new DomainError("INVALID_MEMBER_CARD", "This member card QR is not valid (it may have been altered). Search by name or phone instead.");
    via = "MEMBER_CARD";
    const fam = await familyOf(prisma, memberId);
    ids = (await prisma.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM refund_requests r JOIN bills b ON b.id = r.bill_id
       WHERE r.status = 'APPROVED' AND r.collect_status = 'READY_TO_COLLECT' AND b.member_id = ANY(${fam}::text[])
       ORDER BY r.ready_at LIMIT ${READY_SQL_LIMIT}`).map((r) => r.id);
  } else {
    if (t.length < 2) return { via, refunds: [] };
    const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const phone = t.replace(/\D/g, "");
    const phoneLike = phone.length >= 4 ? `%${phone}%` : null;
    ids = (await prisma.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM refund_requests r
        JOIN bills b ON b.id = r.bill_id
        LEFT JOIN members m ON m.id = b.member_id
        LEFT JOIN guests g ON g.id = b.guest_id
        LEFT JOIN bookings bk ON bk.bill_id = b.id
        LEFT JOIN shop_orders so ON so.bill_id = b.id
        LEFT JOIN counter_sales cs ON cs.bill_id = b.id
        LEFT JOIN tabs tb ON tb.bill_id = b.id
       WHERE r.status = 'APPROVED' AND r.collect_status = 'READY_TO_COLLECT'
         AND (r.code ILIKE ${like} OR b.customer_name ILIKE ${like} OR m.name ILIKE ${like} OR m.member_code ILIKE ${like}
              OR bk.booking_code ILIKE ${like} OR so.code ILIKE ${like} OR cs.code ILIKE ${like} OR tb.code ILIKE ${like}
              OR (${phoneLike}::text IS NOT NULL AND (regexp_replace(COALESCE(m.phone, ''), '[^0-9]', '', 'g') LIKE ${phoneLike}::text
                                                      OR regexp_replace(COALESCE(g.phone, ''), '[^0-9]', '', 'g') LIKE ${phoneLike}::text)))
       ORDER BY r.ready_at LIMIT ${READY_SQL_LIMIT}`).map((r) => r.id);
  }
  const found = await collectable(prisma, ids);
  const allowed: CollectableRefund[] = [];
  for (const r of found) {
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
    if (actor.kind === "SYSTEM" || can(actor, BILL_CAPABILITY[bill.sourceType])) allowed.push(r);
  }
  return { via, refunds: allowed };
}

/** One refund as the pay-out form shows it (member photo, what to collect, what to ask a guest). */
export async function collectableRefund(actor: Actor, id: string): Promise<CollectableRefund> {
  assertDeskRefunds(actor);
  const [r] = await collectable(prisma, [id]);
  if (!r) throw new DomainError("NOT_FOUND", "Refund request was not found.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
  if (!staffCanSeeBill(actor, bill)) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this refund.");
  return r;
}

// ───────────── RF-10: unclaimed refunds ─────────────

/** Days after becoming ready to collect: 3 and 7, then every 14 days — at most 4 reminders. */
export const REFUND_REMINDER_DAYS = [3, 7, 21, 35] as const;

/**
 * RF-10 (daily job): refunds waiting at the desk never expire; the member is reminded on the schedule above. Each
 * reminder goes out once (per refund and reminder number); a job that missed a day sends only the latest one due.
 */
export async function runRefundReminders(now: Date = clock.now()) {
  const ready = await prisma.refundRequest.findMany({ where: { status: "APPROVED", collectStatus: "READY_TO_COLLECT", remindersSent: { lt: REFUND_REMINDER_DAYS.length } }, select: { id: true, readyAt: true, remindersSent: true } });
  let reminded = 0;
  for (const r of ready) {
    if (!r.readyAt) continue;
    const days = (now.getTime() - r.readyAt.getTime()) / DAY;
    const due = REFUND_REMINDER_DAYS.filter((d) => days >= d).length;
    if (due <= r.remindersSent) continue;
    const sent = await withTx(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM refund_requests WHERE id = ${r.id} AND status = 'APPROVED' AND collect_status = 'READY_TO_COLLECT' AND reminders_sent < ${due} FOR UPDATE`;
      if (!locked.length) return false;
      await tx.refundRequest.update({ where: { id: r.id }, data: { remindersSent: due, lastReminderAt: now } });
      await audit(tx, SYSTEM, "refund_request.unclaimed_reminder", "refund_request", r.id, { after: { reminder: due, daysWaiting: Math.floor(days) } });
      await notifyRefund(tx, SYSTEM, r.id, "REMINDER", { reminder: due });
      return true;
    });
    if (sent) reminded++;
  }
  return { reminded };
}

/**
 * RF-10: approved refunds waiting to be collected at the desk (a liability until paid out — "Refunds payable" in
 * What we owe): how many, how much is still to hand over, and how many days the oldest has waited.
 */
export async function refundsPayableSummary(): Promise<{ count: number; amountPaise: number; oldestDays: number | null }> {
  const rows = await prisma.$queryRaw<{ count: bigint; amount: bigint | null; oldest: Date | null }[]>`
    SELECT COUNT(DISTINCT r.id) AS count, COALESCE(SUM(p.amount), 0) AS amount, MIN(COALESCE(r.ready_at, r.decided_at, r.created_at)) AS oldest
      FROM refund_requests r JOIN payments p ON p.refund_request_id = r.id AND p.type = 'REFUND' AND p.status = 'PENDING'
     WHERE r.status = 'APPROVED'`;
  const r = rows[0];
  const count = Number(r?.count ?? 0);
  const oldestDays = count && r?.oldest ? Math.max(0, Math.floor((clock.now().getTime() - new Date(r.oldest).getTime()) / DAY)) : null;
  return { count, amountPaise: Number(r?.amount ?? 0), oldestDays };
}

// ───────────── read side ─────────────

const AREA_WORDS: Record<string, string> = { DESK: "front desk", SHOP: "shop counter", BAR: "bar", OFFICE: "office" };

/** Names of the people on a refund, and how and where it was paid out. */
async function refundStory(db: Tx | typeof prisma, r: { requestedBy: string | null; decidedBy: string | null; identityCheckedBy: string | null; id: string }) {
  const ids = [r.requestedBy, r.decidedBy, r.identityCheckedBy].filter((x): x is string => !!x);
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
  const paid = await db.payment.findMany({ where: { refundRequestId: r.id, type: "REFUND", status: "SUCCEEDED" }, orderBy: { occurredAt: "asc" }, select: { method: true, amount: true, receivedBy: true, drawerSessionId: true, occurredAt: true } });
  const payers = paid.length ? await db.user.findMany({ where: { id: { in: paid.map((p) => p.receivedBy).filter((x): x is string => !!x) } }, select: { id: true, name: true } }) : [];
  const sessions = paid.some((p) => p.drawerSessionId) ? await db.cashDrawerSession.findMany({ where: { id: { in: paid.map((p) => p.drawerSessionId).filter((x): x is string => !!x) } }, select: { id: true, area: true } }) : [];
  return {
    requestedByName: name(r.requestedBy), decidedByName: name(r.decidedBy), identityCheckedByName: name(r.identityCheckedBy),
    paidOut: paid.map((p) => ({
      method: p.method, methodLabel: METHOD_WORDS[p.method] ?? p.method.toLowerCase(), amount: p.amount, at: p.occurredAt,
      by: payers.find((u) => u.id === p.receivedBy)?.name ?? null,
      where: p.method === "ONLINE" ? "back to the card or account paid with" : AREA_WORDS[sessions.find((s) => s.id === p.drawerSessionId)?.area ?? ""] ?? null,
    })),
  };
}

export async function getRefundRequest(actor: Actor, id: string) {
  const r = await prisma.refundRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("NOT_FOUND", "Refund request was not found.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
  const isFamily = actor.kind === "USER" && actor.role === "MEMBER" && !!actor.memberId && !!bill.memberId && (await familyOf(prisma, actor.memberId)).includes(bill.memberId);
  if (!isFamily && !(actor.kind === "SYSTEM" || (actor.kind === "USER" && actor.role !== "MEMBER" && staffCanSeeBill(actor, bill)))) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this refund.");
  const payments = await prisma.payment.findMany({ where: { refundRequestId: id }, orderBy: { occurredAt: "asc" }, select: { id: true, method: true, amount: true, status: true, reference: true, occurredAt: true } });
  const original = await prisma.payment.findMany({ where: { billId: r.billId, type: "PAYMENT", status: "SUCCEEDED" }, select: { method: true } });
  const story = await refundStory(prisma, r);
  const left = await refundableNow(prisma as unknown as Tx, bill);
  return {
    ...r, customer: bill.customerName, billSource: bill.sourceType, billTotal: bill.total, what: await describeBill(prisma as unknown as Tx, bill),
    originalCode: actor.kind === "USER" && actor.role !== "MEMBER" ? await billSourceCode(prisma as unknown as Tx, bill) : null,
    payments, originalMethods: [...new Set(original.map((p) => p.method))], refundableLeft: Math.max(0, left),
    reasonLabel: REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason, ...story,
  };
}

// ───────────── v4 §3.4: the member portal ─────────────

function assertPortal(actor: Actor): string {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Only members can see this page.");
  return actor.memberId;
}

/**
 * The member's (and their Juniors') refunds, newest first, with the timeline (Requested → Approved → Ready to collect
 * → Collected), who approved, how and where it was paid out, the collection QR value while it waits, and the items
 * they may still ask a refund for with the amount left on each (RF-11).
 */
export async function myRefunds(actor: Actor) {
  const me = assertPortal(actor);
  const fam = await familyOf(prisma, me);
  const members = await prisma.member.findMany({ where: { id: { in: fam } }, select: { id: true, name: true } });
  const bills = await prisma.bill.findMany({ where: { memberId: { in: fam } }, select: { id: true } });
  const reqs = await prisma.refundRequest.findMany({ where: { billId: { in: bills.map((b) => b.id) } }, orderBy: [{ createdAt: "desc" }, { code: "desc" }], take: 200 });
  const refunds = [];
  for (const r of reqs) {
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
    const story = await refundStory(prisma, r);
    const waiting = await prisma.payment.aggregate({ where: { refundRequestId: r.id, type: "REFUND", status: "PENDING" }, _sum: { amount: true } });
    refunds.push({
      id: r.id, code: r.code, amount: r.amount, status: r.status, collectStatus: r.collectStatus, reason: REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason,
      note: r.requestedVia === "MEMBER" ? r.note : null, what: await describeBill(prisma as unknown as Tx, bill), billSource: bill.sourceType,
      forName: bill.memberId === me ? null : (members.find((m) => m.id === bill.memberId)?.name ?? null),
      requestedAt: r.createdAt, requestedVia: r.requestedVia, decidedAt: r.decidedAt, approvedBy: r.autoApproved ? null : story.decidedByName, autoApproved: r.autoApproved,
      decisionNote: r.status === "REJECTED" ? r.decisionNote : null, readyAt: r.readyAt, completedAt: r.completedAt, toCollect: waiting._sum.amount ?? 0,
      paidOut: story.paidOut.map((p) => ({ method: p.methodLabel, amount: p.amount, at: p.at, where: p.where })),
      token: r.status === "APPROVED" && r.collectStatus === "READY_TO_COLLECT" ? refundCollectToken(r.id) : null,
    });
  }
  // Items a refund may still be asked for (eligible, with money left and nothing already waiting for approval).
  const candidates = await prisma.bill.findMany({ where: { memberId: { in: fam }, sourceType: { in: ["BOOKING", "SHOP_ORDER"] } }, orderBy: { createdAt: "desc" }, take: 200 });
  const eligible = [];
  for (const b of candidates) {
    if (netPaid(b) <= 0) continue;
    const e = await eligibleMemberRefund(prisma, b.memberId!, b);
    if (!e) continue;
    const left = await refundableNow(prisma as unknown as Tx, b);
    if (left <= 0) continue;
    eligible.push({ billId: b.id, what: await describeBill(prisma as unknown as Tx, b), refundable: left, paid: netPaid(b), reason: REFUND_REASON_LABEL[e.reason], forName: b.memberId === me ? null : (members.find((m) => m.id === b.memberId)?.name ?? null) });
  }
  const ready = refunds.filter((r) => r.token);
  return { refunds, eligible, ready: { count: ready.length, amount: ready.reduce((a, r) => a + r.toCollect, 0) } };
}

/** The collection QR of one of the member's (or their Junior's) refunds, while it waits at the desk. */
export async function myRefundToken(actor: Actor, id: string) {
  const r = await getRefundRequest(actor, id);
  if (r.status !== "APPROVED" || r.collectStatus !== "READY_TO_COLLECT") throw new DomainError("ORDER_STATE_INVALID", "This refund is not waiting at the desk.");
  return { token: refundCollectToken(r.id) };
}

/** v4 §3.4 Payments tab: every payment and refund on the member's (and Juniors') bills, oldest first, with running totals. */
export async function myPayments(actor: Actor) {
  const me = assertPortal(actor);
  const fam = await familyOf(prisma, me);
  const members = await prisma.member.findMany({ where: { id: { in: fam } }, select: { id: true, name: true } });
  const bills = await prisma.bill.findMany({ where: { memberId: { in: fam } } });
  const pays = await prisma.payment.findMany({ where: { billId: { in: bills.map((b) => b.id) }, status: { in: ["SUCCEEDED", "PENDING"] } }, orderBy: { occurredAt: "asc" }, take: 1000 });
  const invoices = await prisma.invoice.findMany({ where: { billId: { in: bills.map((b) => b.id) } }, select: { id: true, billId: true, number: true } });
  const reqs = await prisma.refundRequest.findMany({ where: { id: { in: pays.map((p) => p.refundRequestId).filter((x): x is string => !!x) } }, select: { id: true, code: true, status: true } });
  const what = new Map<string, string>();
  for (const b of bills) if (pays.some((p) => p.billId === b.id)) what.set(b.id, await describeBill(prisma as unknown as Tx, b));
  let paid = 0;
  let refunded = 0;
  const rows = [];
  for (const p of pays) {
    // Money only counts once it has moved: a refund waiting at the desk is shown, not yet added.
    if (p.status === "SUCCEEDED") {
      if (p.type === "PAYMENT") paid += p.amount;
      else refunded += p.amount;
    }
    if (p.type === "PAYMENT" && p.status !== "SUCCEEDED") continue;
    const bill = bills.find((b) => b.id === p.billId)!;
    const inv = invoices.find((i) => i.billId === p.billId);
    const req = p.refundRequestId ? reqs.find((r) => r.id === p.refundRequestId) : null;
    rows.push({
      id: p.id, at: p.occurredAt, type: p.type, method: METHOD_WORDS[p.method] ?? p.method.toLowerCase(), amount: p.amount, status: p.status,
      what: what.get(p.billId) ?? BILL_WHAT[bill.sourceType], forName: bill.memberId === me ? null : (members.find((m) => m.id === bill.memberId)?.name ?? null),
      refundCode: req?.code ?? null,
      receipt: inv ? `/portal/invoices/${inv.id}` : p.type === "REFUND" && req?.status === "COMPLETED" ? `/portal/refunds/${req.id}/receipt` : `/portal/receipts/${p.billId}`,
      runningPaid: paid, runningRefunded: refunded, runningNet: paid - refunded,
    });
  }
  return { rows: rows.reverse(), totals: { paid, refunded, net: paid - refunded } };
}

/** An 80 mm receipt of a member's bill (portal "Payments" links), for their own and their Juniors' bills. */
export async function myBillReceipt(actor: Actor, billId: string) {
  const me = assertPortal(actor);
  const bill = await prisma.bill.findUnique({ where: { id: billId }, include: { lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { occurredAt: "asc" } } } });
  if (!bill || !bill.memberId || !(await familyOf(prisma, me)).includes(bill.memberId)) throw new DomainError("NOT_FOUND", "Receipt was not found.");
  return { bill, code: await billSourceCode(prisma as unknown as Tx, bill), what: await describeBill(prisma as unknown as Tx, bill) };
}

// ───────────── RF-9 step 5: the refund receipt ─────────────

/** Everything an 80 mm refund receipt shows: refund code, amount, original bill, who paid it out, when, how. */
export async function refundReceipt(actor: Actor, id: string) {
  const r = await getRefundRequest(actor, id);
  if (r.status !== "COMPLETED") throw new DomainError("ORDER_STATE_INVALID", "A receipt is available once the refund is paid out.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId } });
  const member = bill.memberId ? await prisma.member.findUnique({ where: { id: bill.memberId }, select: { memberCode: true } }) : null;
  const s = await getSettings();
  return {
    club: { name: s.club.name || "Club", address: s.club.address, phone: s.club.phone },
    code: r.code, amount: r.amount, reason: r.reasonLabel, customer: bill.customerName, memberCode: member?.memberCode ?? null,
    original: { what: r.what, code: await billSourceCode(prisma as unknown as Tx, bill), at: bill.createdAt, total: bill.total, paid: bill.amountPaid },
    paidOut: r.paidOut, completedAt: r.completedAt, identityCheckedBy: r.identityCheckedByName, approvedBy: r.autoApproved ? `policy ${r.policy ?? ""}`.trim() : r.decidedByName,
    printedAt: clock.now(),
  };
}

// ───────────── v4 §5.3: /rq/<token> — the public collection QR page ─────────────

/**
 * Read-only, no login: the refund code, the amount waiting and the member's first name — nothing else personal. The
 * token is the signed collection QR value itself (RF-8); a forged or altered token shows nothing.
 */
export async function publicRefundByToken(token: string) {
  const id = verifyRefundCollectToken(token);
  if (!id) throw new DomainError("INVALID_REFUND_QR", "This refund link is not valid. Please use the link from your message, or ask at the front desk.");
  const r = await prisma.refundRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("NOT_FOUND", "This refund was not found.");
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: r.billId }, select: { customerName: true, memberId: true } });
  const member = bill.memberId ? await prisma.member.findUnique({ where: { id: bill.memberId }, select: { name: true } }) : null;
  const waiting = await prisma.payment.aggregate({ where: { refundRequestId: r.id, type: "REFUND", status: "PENDING" }, _sum: { amount: true } });
  const state = r.status === "APPROVED" && r.collectStatus === "READY_TO_COLLECT" ? "READY" : r.status === "COMPLETED" ? "COLLECTED" : "CLOSED";
  return {
    code: r.code, firstName: (member?.name ?? bill.customerName).trim().split(/\s+/)[0] ?? "",
    amount: state === "READY" ? (waiting._sum.amount ?? r.amount) : r.amount, state, readyAt: r.readyAt, completedAt: r.completedAt,
    token: refundCollectToken(r.id),
  } as const;
}
