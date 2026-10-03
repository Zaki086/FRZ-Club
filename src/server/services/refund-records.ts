// v3 §5.2: refund request records. Shared by the payment engine (policy refunds create an already-approved request)
// and the refund workflow (refunds.ts), so neither imports the other.
import type { Bill } from "@prisma/client";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { audit } from "./audit";
import { BILL_PORTAL_LINK, BILL_WHAT, lockBill, netPaid } from "./bills";
import { getSettings } from "./settings";
import { memberAudience, notifyMember, type MemberEvent } from "./channels";
import { fmtDate, fmtRange, istDate } from "@/lib/time";
import { notify } from "./notifications";

export const REFUND_REASONS = ["POLICY_CANCELLATION", "CLUB_CANCELLATION", "PRODUCT_RETURN", "SERVICE_ISSUE", "DUPLICATE_CHARGE", "GOODWILL", "OTHER"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  POLICY_CANCELLATION: "Cancellation within policy", CLUB_CANCELLATION: "Cancelled by the club", PRODUCT_RETURN: "Product return",
  SERVICE_ISSUE: "Service issue", DUPLICATE_CHARGE: "Duplicate or over-payment", GOODWILL: "Goodwill", OTHER: "Other",
};
export type RefundStatus = "REQUESTED" | "APPROVED" | "COMPLETED" | "REJECTED" | "FAILED" | "CANCELLED";

/** Who asked: a member from the portal, staff, or the system (jobs, gateway). */
export function requestedVia(actor: Actor): "STAFF" | "MEMBER" | "SYSTEM" {
  if (actor.kind !== "USER") return "SYSTEM";
  return actor.role === "MEMBER" ? "MEMBER" : "STAFF";
}

export async function nextRefundCode(tx: Tx): Promise<string> {
  const [r] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('refund_request_code_seq') AS n`;
  return `RF-${String(Number(r.n)).padStart(6, "0")}`;
}

/** RF-3: a policy refund (in-time cancellation, club cancellation, hold expiry, late payment, return window) is created approved. */
export async function createPolicyRequest(tx: Tx, actor: Actor, input: { billId: string; amount: number; reason: RefundReason; note: string; policy: string }) {
  const r = await tx.refundRequest.create({
    data: {
      code: await nextRefundCode(tx), billId: input.billId, amount: input.amount, reason: input.reason, note: input.note,
      status: "APPROVED", autoApproved: true, policy: input.policy, requestedVia: requestedVia(actor),
      requestedBy: actor.kind === "USER" ? actor.userId : null, decidedAt: clock.now(),
    },
  });
  await audit(tx, actor, "refund_request.auto_approved", "refund_request", r.id, { after: { code: r.code, billId: r.billId, amount: r.amount, reason: r.reason, policy: r.policy } });
  return r;
}

/** "court booking BK-000123 (Court 1, Mon 12 Oct 18:00–19:00)" — what a refund is for, in the member's words. */
async function describeBill(tx: Tx, bill: Bill): Promise<string> {
  const what = BILL_WHAT[bill.sourceType];
  if (bill.sourceType === "BOOKING") {
    const b = await tx.booking.findFirst({ where: { billId: bill.id }, include: { reservation: { include: { court: true } } } });
    if (b) return `${what} ${b.bookingCode} (${b.reservation.court.name}, ${fmtDate(istDate(b.reservation.startAt))} ${fmtRange(b.reservation.startAt, b.reservation.endAt)})`;
  }
  if (bill.sourceType === "SOCIAL_JOIN") {
    const p = await tx.socialParticipant.findFirst({ where: { billId: bill.id }, include: { session: true } });
    if (p) return `${what} “${p.session.title}” (${fmtDate(istDate(p.session.startAt))} ${fmtRange(p.session.startAt, p.session.endAt)})`;
  }
  if (bill.sourceType === "SHOP_ORDER") {
    const o = await tx.shopOrder.findFirst({ where: { billId: bill.id }, select: { code: true } });
    if (o) return `${what} ${o.code}`;
  }
  return what;
}

const METHOD_WORDS: Record<string, string> = { CASH: "cash", UPI: "UPI", CARD: "card", ONLINE: "online", BANK_TRANSFER: "bank transfer" };

/**
 * Tell the member (and a Junior's guardian) where their refund stands, on every channel: asked for (waiting for a
 * manager), approved (collect it at the desk, or on its way back online), not approved (with the reason), completed.
 * Bills without a member (walk-in guests) have no one to tell here. Exactly once per request and step.
 */
export async function notifyRefund(tx: Tx, actor: Actor, requestId: string, step: "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED") {
  const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
  // "Approved" only while money is still on its way; once it is paid the completion message says it all.
  if (step === "APPROVED" && r.status !== "APPROVED") return;
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: r.billId } });
  if (!bill.memberId) return;
  const audience = await memberAudience(tx, [bill.memberId]);
  if (!audience.length) return;
  const member = await tx.member.findUniqueOrThrow({ where: { id: bill.memberId }, select: { name: true } });
  const what = await describeBill(tx, bill);
  const amount = formatINR(r.amount);
  const pays = await tx.payment.findMany({ where: { refundRequestId: r.id, type: "REFUND" } });
  const atDesk = pays.some((p) => p.status === "PENDING");
  const online = pays.some((p) => p.method === "ONLINE");
  const methods = [...new Set(pays.filter((p) => p.status === "SUCCEEDED").map((p) => METHOD_WORDS[p.method] ?? p.method.toLowerCase()))].join(" + ");
  const m: Record<typeof step, { event: MemberEvent; title: string; body: string; params: string[] }> = {
    REQUESTED: {
      event: "REFUND_REQUESTED", title: `Refund of ${amount} asked for`,
      body: `${r.code} · ${amount} for your ${what} (${REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason}). A manager approves it; you will hear from us as soon as it is decided.`,
      params: [member.name, amount, r.code],
    },
    APPROVED: {
      event: "REFUND_APPROVED", title: `Refund of ${amount} approved`,
      body: `${r.code} · ${amount} for your ${what}. ${atDesk ? `It is ready at the front desk: collect it on your next visit (say refund ${r.code}).` : "It is on its way back to the card or account you paid with."}`,
      params: [member.name, amount, r.code, atDesk ? "at the front desk" : "back to your card or account"],
    },
    REJECTED: {
      event: "REFUND_REJECTED", title: `Refund of ${amount} not approved`,
      body: `${r.code} · ${amount} for your ${what} was not approved. Reason: ${r.decisionNote ?? "not given"}. Questions? Please ask at the front desk.`,
      params: [member.name, amount, r.code, r.decisionNote ?? ""],
    },
    COMPLETED: {
      event: "REFUND_COMPLETED", title: `Refund of ${amount} completed`,
      body: `${r.code} · ${amount} for your ${what} was paid back${methods ? ` (${methods})` : ""}.${online ? " Online refunds go back to the card or account you paid with and can take a few working days to show." : ""}`,
      params: [member.name, amount, r.code],
    },
  };
  const msg = m[step];
  for (const a of audience) {
    await notifyMember(tx, {
      event: msg.event, userId: a.userId, memberId: a.memberId, actor, title: msg.title, body: msg.body, link: BILL_PORTAL_LINK[bill.sourceType],
      dedupeKey: `refund-${step.toLowerCase()}:${r.id}${a.userId === audience[0].userId ? "" : `:${a.userId}`}`, params: msg.params,
    });
  }
}

/**
 * RF-5: once every refund payment of a request has gone out, the request is COMPLETED and the customer is told
 * (unless `quiet`: the caller sends its own message, e.g. the automatic club-cancellation refund). Returns the status.
 */
export async function settleRequestIfPaid(tx: Tx, actor: Actor, requestId: string, opts: { quiet?: boolean } = {}): Promise<RefundStatus> {
  const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (r.status !== "APPROVED") return r.status as RefundStatus;
  const pays = await tx.payment.findMany({ where: { refundRequestId: r.id, type: "REFUND" } });
  const paid = pays.filter((p) => p.status === "SUCCEEDED").reduce((a, p) => a + p.amount, 0);
  if (pays.some((p) => p.status === "PENDING") || paid !== r.amount) return "APPROVED";
  await tx.refundRequest.update({ where: { id: r.id }, data: { status: "COMPLETED", completedAt: clock.now() } });
  await audit(tx, actor, "refund_request.completed", "refund_request", r.id, { before: { status: "APPROVED" }, after: { status: "COMPLETED", by: actorId(actor) } });
  if (!opts.quiet) await notifyRefund(tx, actor, r.id, "COMPLETED");
  return "COMPLETED";
}

/** Money on the bill that is not already refunded, waiting to be paid out, or asked for in an open request. */
export async function refundableNow(tx: Tx, bill: Bill): Promise<number> {
  const open = await tx.refundRequest.aggregate({ where: { billId: bill.id, status: "REQUESTED" }, _sum: { amount: true } });
  return netPaid(bill) - (open._sum.amount ?? 0);
}


/** RF-2/RF-3: a request that waits for approval (Manager up to the limit, Owner above). */
export async function createRequestedTx(tx: Tx, actor: Actor, input: { billId: string; amount: number; reason: RefundReason; note: string }) {
  const bill = await lockBill(tx, input.billId);
  const available = await refundableNow(tx, bill);
  if (input.amount > available) {
    throw new DomainError("REFUND_EXCEEDS_PAID", `A refund of ${formatINR(input.amount)} is more than the ${formatINR(Math.max(0, available))} that can still be refunded on this bill.`, { refundable: Math.max(0, available), amount: input.amount });
  }
  const r = await tx.refundRequest.create({
    data: {
      code: await nextRefundCode(tx), billId: bill.id, amount: input.amount, reason: input.reason, note: input.note,
      status: "REQUESTED", requestedVia: requestedVia(actor), requestedBy: actor.kind === "USER" ? actor.userId : null,
    },
  });
  await audit(tx, actor, "refund_request.requested", "refund_request", r.id, { after: { code: r.code, billId: bill.id, amount: r.amount, reason: r.reason }, reason: input.note });
  const s = await getSettings(tx);
  await notify(tx, {
    roles: input.amount > s.refund_manager_limit ? ["OWNER"] : ["MANAGER", "OWNER"], type: "REFUND_REQUESTED",
    title: `Refund to approve: ${formatINR(r.amount)}`,
    body: `${r.code} · ${bill.customerName} · ${REFUND_REASON_LABEL[input.reason]} · ${input.note}`,
    link: `/app/refunds?status=REQUESTED`, dedupeKey: `refund-requested:${r.id}`,
  });
  await notifyRefund(tx, actor, r.id, "REQUESTED");
  return r;
}
