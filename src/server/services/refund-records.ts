// v3 §5.2: refund request records. Shared by the payment engine (policy refunds create an already-approved request)
// and the refund workflow (refunds.ts), so neither imports the other.
// v4 §3: an approved refund whose money waits at the desk is READY_TO_COLLECT (RF-8, a sub-status of APPROVED) with a
// signed collection QR; once paid out it is COLLECTED. Every step reaches the member on every channel (§3.6), with the
// WhatsApp template values (§5.2) and the approvers' push (REFUND_APPROVAL_NEEDED).
import type { Bill } from "@prisma/client";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { audit } from "./audit";
import { BILL_WHAT, lockBill, netPaid } from "./bills";
import { getSettings } from "./settings";
import { absolute, memberAudience, notifyMember, type MemberEvent } from "./channels";
import { fmtDate, fmtDateTime, fmtRange, istDate } from "@/lib/time";
import { refundCollectToken } from "./refund-qr";
import type { WaMessage } from "./whatsapp/templates";

export const REFUND_REASONS = ["POLICY_CANCELLATION", "CLUB_CANCELLATION", "PRODUCT_RETURN", "SERVICE_ISSUE", "DUPLICATE_CHARGE", "GOODWILL", "OTHER"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  POLICY_CANCELLATION: "Cancellation within policy", CLUB_CANCELLATION: "Cancelled by the club", PRODUCT_RETURN: "Product return",
  SERVICE_ISSUE: "Service issue", DUPLICATE_CHARGE: "Duplicate or over-payment", GOODWILL: "Goodwill", OTHER: "Other",
};
export type RefundStatus = "REQUESTED" | "APPROVED" | "COMPLETED" | "REJECTED" | "FAILED" | "CANCELLED";
/** v4 RF-8: where money waiting at the desk stands (null: nothing waits at the desk for this request). */
export type CollectStatus = "READY_TO_COLLECT" | "COLLECTED";

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

/** The human code of what a bill is for (booking BK-…, order, sale, tab, restring ticket, invoice number), if any. */
export async function billSourceCode(tx: Tx, bill: Bill): Promise<string | null> {
  switch (bill.sourceType) {
    case "BOOKING": return (await tx.booking.findFirst({ where: { billId: bill.id }, select: { bookingCode: true } }))?.bookingCode ?? null;
    case "SHOP_ORDER": return (await tx.shopOrder.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code ?? null;
    case "COUNTER_SALE": return (await tx.counterSale.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code ?? null;
    case "SERVICE_TICKET": return (await tx.serviceTicket.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code ?? null;
    case "BAR_TAB": return (await tx.tab.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code ?? null;
    case "INVOICE": return (await tx.invoice.findFirst({ where: { billId: bill.id }, select: { number: true } }))?.number ?? null;
    default: return null;
  }
}

/** "court booking BK-000123 (Court 1, Mon 12 Oct 18:00–19:00)" — what a refund is for, in the member's words. */
export async function describeBill(tx: Tx, bill: Bill): Promise<string> {
  const what = BILL_WHAT[bill.sourceType];
  if (bill.sourceType === "BOOKING") {
    const b = await tx.booking.findFirst({ where: { billId: bill.id }, include: { reservation: { include: { court: true } } } });
    if (b) return `${what} ${b.bookingCode} (${b.reservation.court.name}, ${fmtDate(istDate(b.reservation.startAt))} ${fmtRange(b.reservation.startAt, b.reservation.endAt)})`;
  }
  if (bill.sourceType === "SOCIAL_JOIN") {
    const p = await tx.socialParticipant.findFirst({ where: { billId: bill.id }, include: { session: true } });
    if (p) return `${what} “${p.session.title}” (${fmtDate(istDate(p.session.startAt))} ${fmtRange(p.session.startAt, p.session.endAt)})`;
  }
  const code = await billSourceCode(tx, bill);
  return code ? `${what} ${code}` : what;
}

export const METHOD_WORDS: Record<string, string> = { CASH: "cash", UPI: "UPI", CARD: "card", ONLINE: "online", BANK_TRANSFER: "bank transfer" };

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** Amounts in WhatsApp template values are rupees as shown after "₹" (e.g. "550" or "1,250.50"). */
const waRupees = (paise: number) => formatINR(paise).replace("₹", "");

export type RefundStep = "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED" | "REMINDER";

/**
 * Tell the member (and a Junior's guardian) where their refund stands, on every channel: asked for (waiting for a
 * manager), ready to collect at the front desk with the refund code, desk hours and QR link (or approved and on its
 * way back online), not approved (with the reason), collected / completed (with the receipt), still waiting
 * (RF-10 reminder `n`). Bills without a member (walk-in guests) have no one to tell here. Exactly once per request,
 * step and recipient (a reminder: per reminder number).
 */
export async function notifyRefund(tx: Tx, actor: Actor, requestId: string, step: RefundStep, opts: { reminder?: number } = {}) {
  const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
  // "Approved" only while money is still on its way; once it is paid the completion message says it all.
  if (step === "APPROVED" && r.status !== "APPROVED") return;
  if (step === "REMINDER" && r.collectStatus !== "READY_TO_COLLECT") return;
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: r.billId } });
  if (!bill.memberId) return;
  const audience = await memberAudience(tx, [bill.memberId]);
  if (!audience.length) return;
  const member = await tx.member.findUniqueOrThrow({ where: { id: bill.memberId }, select: { name: true, userId: true } });
  const users = await tx.user.findMany({ where: { id: { in: audience.map((a) => a.userId) } }, select: { id: true, name: true } });
  const what = await describeBill(tx, bill);
  const s = await getSettings(tx);
  const pays = await tx.payment.findMany({ where: { refundRequestId: r.id, type: "REFUND" } });
  const waiting = pays.filter((p) => p.status === "PENDING").reduce((a, p) => a + p.amount, 0);
  const succeeded = pays.filter((p) => p.status === "SUCCEEDED");
  const atDesk = r.collectStatus === "READY_TO_COLLECT" || waiting > 0;
  const online = pays.some((p) => p.method === "ONLINE");
  const allCash = succeeded.length > 0 && succeeded.every((p) => p.method === "CASH");
  const methods = [...new Set(succeeded.map((p) => METHOD_WORDS[p.method] ?? p.method.toLowerCase()))].join(" + ");
  const amount = formatINR(r.amount);
  const toCollect = formatINR(waiting || r.amount);
  const hours = `${s.opening_hours.open}–${s.opening_hours.close}`;
  const token = refundCollectToken(r.id);
  const qrUrl = absolute(`/rq/${token}`) || `/rq/${token}`;
  const portal = `/portal/refunds?ref=${r.code}`;
  const paidOn = r.completedAt ?? clock.now();
  const reason = REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason;

  for (const [i, a] of audience.entries()) {
    const self = a.userId === member.userId;
    const name = firstName(users.find((u) => u.id === a.userId)?.name ?? member.name);
    const whose = self ? "your" : `${firstName(member.name)}'s`;
    let msg: { event: MemberEvent; key: string; title: string; body: string; link: string; params: string[]; wa?: WaMessage };
    switch (step) {
      case "REQUESTED":
        msg = {
          event: "REFUND_REQUESTED", key: `refund-requested:${r.id}`, title: `Refund of ${amount} asked for`, link: portal,
          body: `${r.code} · ${amount} for ${whose} ${what} (${reason}). A manager approves it; you will hear from us as soon as it is decided.`,
          params: [name, amount, r.code],
        };
        break;
      case "APPROVED":
        msg = atDesk
          ? {
              event: "REFUND_READY_TO_COLLECT", key: `refund-ready:${r.id}`, title: `Refund of ${toCollect} ready to collect`, link: portal,
              body: `${r.code} · ${toCollect} for ${whose} ${what} is ready in cash at the front desk (open ${hours}). Bring your member card or show this QR: ${qrUrl}. It does not expire.`,
              params: [name, toCollect, r.code],
              wa: { template: "refund_ready_to_collect", vars: { name, amount: waRupees(waiting || r.amount), ref: r.code }, button: { token } },
            }
          : {
              event: "REFUND_APPROVED", key: `refund-approved:${r.id}`, title: `Refund of ${amount} approved`, link: portal,
              body: `${r.code} · ${amount} for ${whose} ${what}. It is on its way back to the card or account you paid with.`,
              params: [name, amount, r.code, "back to your card or account"],
            };
        break;
      case "REJECTED":
        msg = {
          event: "REFUND_REJECTED", key: `refund-rejected:${r.id}`, title: `Refund of ${amount} not approved`, link: portal,
          body: `${r.code} · ${amount} for ${whose} ${what} was not approved. Reason: ${r.decisionNote ?? "not given"}. Questions? Please ask at the front desk.`,
          params: [name, amount, r.code, r.decisionNote ?? ""],
          wa: { template: "refund_rejected", vars: { name, ref: r.code, amount: waRupees(r.amount), reason: r.decisionNote ?? "not given" } },
        };
        break;
      case "COMPLETED": {
        const wa: WaMessage | undefined = allCash ? { template: "refund_completed", vars: { name, amount: waRupees(r.amount), date: fmtDate(istDate(paidOn)), ref: r.code } } : undefined;
        // Handed over in cash at the desk → "collected"; anything else (UPI/card at the desk, online) → "completed".
        msg = r.collectStatus === "COLLECTED" && allCash
          ? {
              event: "REFUND_COLLECTED", key: `refund-collected:${r.id}`, title: `Refund of ${amount} collected`, link: `/portal/refunds/${r.id}/receipt`,
              body: `${r.code} · ${amount} for ${whose} ${what} was paid out at the front desk${methods ? ` in ${methods}` : ""} on ${fmtDateTime(paidOn)}. Your receipt is in My refunds.`,
              params: [name, amount, fmtDate(istDate(paidOn)), r.code], wa,
            }
          : {
              event: "REFUND_COMPLETED", key: `refund-completed:${r.id}`, title: `Refund of ${amount} completed`, link: portal,
              body: `${r.code} · ${amount} for ${whose} ${what} was paid back${methods ? ` (${methods})` : ""}.${online ? " Online refunds go back to the card or account you paid with and can take a few working days to show." : ""}`,
              params: [name, amount, r.code], wa,
            };
        break;
      }
      case "REMINDER": {
        const n = opts.reminder ?? r.remindersSent;
        msg = {
          event: "REFUND_UNCLAIMED_REMINDER", key: `refund-unclaimed:${r.id}:${n}`, title: `${toCollect} refund still waiting for you`, link: portal,
          body: `${r.code} · ${toCollect} for ${whose} ${what} has been ready at the front desk since ${fmtDate(istDate(r.readyAt ?? r.decidedAt ?? r.createdAt))}. Collect it any day ${hours}: bring your member card or show this QR: ${qrUrl}.`,
          params: [name, toCollect, r.code],
          wa: { template: "refund_unclaimed_reminder", vars: { name, amount: waRupees(waiting || r.amount), ref: r.code }, button: { token } },
        };
        break;
      }
    }
    await notifyMember(tx, {
      event: msg.event, userId: a.userId, memberId: a.memberId, actor, title: msg.title, body: msg.body, link: msg.link,
      dedupeKey: i === 0 ? msg.key : `${msg.key}:${a.userId}`, params: msg.params, ...(msg.wa ? { wa: msg.wa } : {}),
    });
  }
}

/**
 * RF-5: once every refund payment of a request has gone out, the request is COMPLETED and the customer is told
 * (unless `quiet`: the caller sends its own message, e.g. the automatic club-cancellation refund). Returns the status.
 * v4 RF-8: while money of an approved request waits at the desk it is READY_TO_COLLECT (from then on reminders count,
 * RF-10); when that money is paid out it is COLLECTED.
 */
export async function settleRequestIfPaid(tx: Tx, actor: Actor, requestId: string, opts: { quiet?: boolean } = {}): Promise<RefundStatus> {
  const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (r.status !== "APPROVED") return r.status as RefundStatus;
  const pays = await tx.payment.findMany({ where: { refundRequestId: r.id, type: "REFUND" } });
  const paid = pays.filter((p) => p.status === "SUCCEEDED").reduce((a, p) => a + p.amount, 0);
  const waiting = pays.filter((p) => p.status === "PENDING").reduce((a, p) => a + p.amount, 0);
  if (waiting > 0 || paid !== r.amount) {
    if (waiting > 0 && r.collectStatus !== "READY_TO_COLLECT") {
      await tx.refundRequest.update({ where: { id: r.id }, data: { collectStatus: "READY_TO_COLLECT", readyAt: clock.now() } });
      await audit(tx, actor, "refund_request.ready_to_collect", "refund_request", r.id, { before: { status: "APPROVED" }, after: { status: "APPROVED", collect: "READY_TO_COLLECT", waiting } });
    }
    return "APPROVED";
  }
  const collected = r.collectStatus === "READY_TO_COLLECT";
  await tx.refundRequest.update({ where: { id: r.id }, data: { status: "COMPLETED", completedAt: clock.now(), ...(collected ? { collectStatus: "COLLECTED" } : {}) } });
  await audit(tx, actor, "refund_request.completed", "refund_request", r.id, { before: { status: "APPROVED" }, after: { status: "COMPLETED", by: actorId(actor), ...(collected ? { collect: "COLLECTED" } : {}) } });
  if (!opts.quiet) await notifyRefund(tx, actor, r.id, "COMPLETED");
  return "COMPLETED";
}

/** Money on the bill that is not already refunded, waiting to be paid out, or asked for in an open request (RF-11). */
export async function refundableNow(tx: Tx, bill: Bill): Promise<number> {
  const open = await tx.refundRequest.aggregate({ where: { billId: bill.id, status: "REQUESTED" }, _sum: { amount: true } });
  return netPaid(bill) - (open._sum.amount ?? 0);
}

/**
 * v4 §3.3: everyone who may decide this request hears it (in-app + push, REFUND_APPROVAL_NEEDED) with a link to the
 * refund — Managers and the Owner up to the Manager limit, only the Owner above it; never the person who asked.
 */
async function notifyApprovers(tx: Tx, actor: Actor, r: { id: string; code: string; amount: number; requestedBy: string | null }, line: string) {
  const s = await getSettings(tx);
  const roles = r.amount > s.refund_manager_limit ? (["OWNER"] as const) : (["MANAGER", "OWNER"] as const);
  const approvers = await tx.user.findMany({ where: { role: { in: [...roles] }, active: true, ...(r.requestedBy ? { id: { not: r.requestedBy } } : {}) }, select: { id: true } });
  for (const u of approvers) {
    await notifyMember(tx, {
      event: "REFUND_APPROVAL_NEEDED", channels: ["PUSH"], userId: u.id, actor, title: `Refund to approve: ${formatINR(r.amount)}`, body: line,
      link: `/app/refunds/${r.id}`, dedupeKey: `refund-approval-needed:${r.id}:${u.id}`,
    });
  }
}

/** RF-2/RF-3: a request that waits for approval (Manager up to the limit, Owner above). */
export async function createRequestedTx(tx: Tx, actor: Actor, input: { billId: string; amount: number; reason: RefundReason; note: string; policy?: string | null }) {
  const bill = await lockBill(tx, input.billId);
  const available = await refundableNow(tx, bill);
  if (input.amount > available) {
    throw new DomainError("REFUND_EXCEEDS_PAID", `A refund of ${formatINR(input.amount)} is more than the ${formatINR(Math.max(0, available))} that can still be refunded on this bill.`, { refundable: Math.max(0, available), amount: input.amount });
  }
  const r = await tx.refundRequest.create({
    data: {
      code: await nextRefundCode(tx), billId: bill.id, amount: input.amount, reason: input.reason, note: input.note, policy: input.policy ?? null,
      status: "REQUESTED", requestedVia: requestedVia(actor), requestedBy: actor.kind === "USER" ? actor.userId : null,
    },
  });
  await audit(tx, actor, "refund_request.requested", "refund_request", r.id, { after: { code: r.code, billId: bill.id, amount: r.amount, reason: r.reason }, reason: input.note });
  const via = requestedVia(actor) === "MEMBER" ? " · asked for by the member" : "";
  await notifyApprovers(tx, actor, r, `${r.code} · ${bill.customerName} · ${REFUND_REASON_LABEL[input.reason]}${via} · ${input.note}`);
  await notifyRefund(tx, actor, r.id, "REQUESTED");
  return r;
}
