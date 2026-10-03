// v4 §5.3 `/r/<token>`: the club-cancellation choice without a login (the WhatsApp "Choose option" button).
// The token is signed (signed-links.ts), names one club cancellation and expires at its resolution deadline. It can be
// used once: after a choice the cancellation is resolved and the page shows only the outcome. The choice itself is the
// existing service — Reschedule (rescheduleClubCancellation: real availability, every booking rule, no extra charge)
// or Refund (refundClubCancellation: an approved refund; cash refunds wait at the desk) — acted as the person who
// booked (the member's own login, or the system for a guest's booking).
import { z } from "zod";
import { clock } from "@/lib/clock";
import { addDays, istDate, isValidDateStr } from "@/lib/time";
import { prisma, withTx } from "../../db";
import { rateLimit } from "../../rate-limit";
import { DomainError, isDomainError } from "../../errors";
import type { Actor, SystemActor, UserActor } from "../../rbac/actor";
import { audit } from "../audit";
import { CLOSURE_REASON_LABEL, refundClubCancellation, rescheduleClubCancellation } from "../closures";
import { getSettings } from "../settings";
import { inspectResolutionToken, signResolutionToken } from "../signed-links";

/** The WhatsApp button suffix / link path for a club cancellation (valid until its deadline). */
export function resolutionToken(cc: { id: string; deadlineAt: Date }): string {
  return signResolutionToken(cc.id, cc.deadlineAt);
}
export function resolutionPath(cc: { id: string; deadlineAt: Date }): string {
  return `/r/${resolutionToken(cc)}`;
}

type Session = { firstName: string; court: string; sport: string; startAt: string; endAt: string; bookingCode: string; reason: string; amountPaid: number; deadlineAt: string };
export type ResolutionView =
  | { state: "INVALID" }
  | { state: "EXPIRED"; session: Session }
  | { state: "OPEN"; session: Session; today: string; rescheduleUntil: string }
  | {
      state: "DONE";
      session: Session;
      outcome:
        | { kind: "RESCHEDULED"; bookingCode: string; court: string; startAt: string; endAt: string }
        | { kind: "REFUNDED"; amount: number; refundCode: string | null; refundStatus: string | null; collectAtDesk: boolean; auto: boolean };
    };

async function load(id: string) {
  const cc = await prisma.clubCancellation.findUnique({ where: { id } });
  if (!cc) return null;
  const [booking, closure] = await Promise.all([
    prisma.booking.findUniqueOrThrow({ where: { id: cc.bookingId }, include: { reservation: { include: { court: true } } } }),
    prisma.courtClosure.findUnique({ where: { id: cc.closureId } }),
  ]);
  const member = booking.primaryMemberId ? await prisma.member.findUnique({ where: { id: booking.primaryMemberId }, select: { id: true, name: true, userId: true } }) : null;
  const guest = !member && booking.primaryGuestId ? await prisma.guest.findUnique({ where: { id: booking.primaryGuestId }, select: { id: true, name: true } }) : null;
  const label = closure ? (CLOSURE_REASON_LABEL as Record<string, string>)[closure.reason] ?? closure.reason : "Closed by the club";
  const session: Session = {
    // Read-only page without a login: the first name only, no phone, no member code.
    firstName: ((member?.name ?? guest?.name ?? "").trim().split(/\s+/)[0] || "there"),
    court: booking.reservation.court.name,
    sport: booking.reservation.court.sport,
    startAt: booking.reservation.startAt.toISOString(),
    endAt: booking.reservation.endAt.toISOString(),
    bookingCode: booking.bookingCode,
    reason: closure?.note ? `${label}: ${closure.note}` : label,
    amountPaid: cc.amountPaid,
    deadlineAt: cc.deadlineAt.toISOString(),
  };
  return { cc, booking, member, session };
}

async function outcomeOf(cc: { status: string; newBookingId: string | null; refundRequestId: string | null; amountPaid: number; resolvedVia: string | null }) {
  if (cc.status === "RESCHEDULED" && cc.newBookingId) {
    const nb = await prisma.booking.findUniqueOrThrow({ where: { id: cc.newBookingId }, include: { reservation: { include: { court: true } } } });
    return { kind: "RESCHEDULED" as const, bookingCode: nb.bookingCode, court: nb.reservation.court.name, startAt: nb.reservation.startAt.toISOString(), endAt: nb.reservation.endAt.toISOString() };
  }
  const req = cc.refundRequestId ? await prisma.refundRequest.findUnique({ where: { id: cc.refundRequestId } }) : null;
  return {
    kind: "REFUNDED" as const,
    amount: req?.amount ?? cc.amountPaid,
    refundCode: req?.code ?? null,
    refundStatus: req ? (req.collectStatus ?? req.status) : null,
    // Cash refunds are collected at the desk (RF-8 READY_TO_COLLECT; before REFUND's sub-status: APPROVED, not paid).
    collectAtDesk: !!req && (req.collectStatus === "READY_TO_COLLECT" || (req.status === "APPROVED" && !req.completedAt)),
    auto: req?.policy === "CC-6", // no choice by the deadline (a guest's link choice is also recorded as AUTO)
  };
}

/** WA-24: the page and its actions are rate limited per device (and the choice per link). */
export const LINK_LIMITS = { viewPerIp: 60, choosePerIp: 20, choosePerLink: 10, windowMs: 10 * 60_000 } as const;
const TOO_MANY = "Too many attempts from this device. Please wait a few minutes and try again.";

/** WA-20: what `/r/<token>` shows. Forged → INVALID; resolved → DONE (outcome only); past the deadline → EXPIRED. */
export async function viewResolution(token: string, ctx: { ip?: string } = {}): Promise<ResolutionView> {
  if (ctx.ip) rateLimit(`r:view:${ctx.ip}`, LINK_LIMITS.viewPerIp, LINK_LIMITS.windowMs, TOO_MANY);
  const t = inspectResolutionToken(token);
  if (!t) return { state: "INVALID" };
  const x = await load(t.clubCancellationId);
  if (!x) return { state: "INVALID" };
  if (x.cc.status !== "PENDING_CHOICE") return { state: "DONE", session: x.session, outcome: await outcomeOf(x.cc) };
  const now = clock.now().getTime();
  if (t.expiresAt.getTime() <= now || x.cc.deadlineAt.getTime() <= now) return { state: "EXPIRED", session: x.session };
  const s = await getSettings();
  const today = istDate(clock.now());
  return { state: "OPEN", session: x.session, today, rescheduleUntil: addDays(today, s.reschedule_window_days) };
}

export const linkChoiceSchema = z.discriminatedUnion("choice", [
  z.object({ choice: z.literal("REFUND") }),
  z.object({ choice: z.literal("RESCHEDULE"), courtId: z.string().min(1).max(64), date: z.string().refine(isValidDateStr, "date must be YYYY-MM-DD"), startTime: z.string().regex(/^\d{2}:\d{2}$/) }),
]);

const LINK_ACTOR: SystemActor = { kind: "SYSTEM", name: "resolution-link" };

/**
 * WA-21/WA-22: make the choice from the link. Rejects forged (LINK_INVALID), expired (LINK_EXPIRED) and used
 * (LINK_USED) links; every booking rule applies to a reschedule. Returns the outcome view.
 */
export async function resolveByLink(token: string, raw: z.input<typeof linkChoiceSchema>, ctx: { ip?: string } = {}): Promise<ResolutionView> {
  if (ctx.ip) rateLimit(`r:choose:${ctx.ip}`, LINK_LIMITS.choosePerIp, LINK_LIMITS.windowMs, TOO_MANY);
  rateLimit(`r:link:${String(token).slice(-32)}`, LINK_LIMITS.choosePerLink, LINK_LIMITS.windowMs, "Too many attempts with this link. Please wait a few minutes, or ask the front desk.");
  const input = linkChoiceSchema.parse(raw);
  const t = inspectResolutionToken(token);
  if (!t) throw new DomainError("LINK_INVALID", "This link is not valid. Please use the link from your message, or ask the front desk.");
  const x = await load(t.clubCancellationId);
  if (!x) throw new DomainError("LINK_INVALID", "This link is not valid. Please use the link from your message, or ask the front desk.");
  if (x.cc.status !== "PENDING_CHOICE") throw new DomainError("LINK_USED", "A choice was already made for this session.");
  const now = clock.now().getTime();
  if (t.expiresAt.getTime() <= now || x.cc.deadlineAt.getTime() <= now) {
    throw new DomainError("LINK_EXPIRED", "The time to choose has passed. A session nobody chose for is refunded in full automatically.");
  }
  // Act as the person who booked: the member's own login (member booking rules) or the system for a guest booking.
  let actor: Actor = LINK_ACTOR;
  if (x.member?.userId) {
    const u = await prisma.user.findUnique({ where: { id: x.member.userId }, select: { id: true, name: true, role: true, active: true } });
    if (u?.active && u.role === "MEMBER") actor = { kind: "USER", userId: u.id, role: "MEMBER", name: u.name, memberId: x.member.id, employeeId: null } satisfies UserActor;
  }
  try {
    if (input.choice === "RESCHEDULE") await rescheduleClubCancellation(actor, x.cc.id, { courtId: input.courtId, date: input.date, startTime: input.startTime });
    else await refundClubCancellation(actor, x.cc.id);
  } catch (e) {
    // Two taps at once: the second one finds it resolved.
    if (isDomainError(e, "ORDER_STATE_INVALID")) throw new DomainError("LINK_USED", "A choice was already made for this session.");
    throw e;
  }
  // resolved_via stays what the choice service recorded (MEMBER, or AUTO for a guest's booking — its CHECK allows
  // no other value); the audit row says the choice came through the signed link.
  await withTx((tx) => audit(tx, actor, "club_cancellation.link_used", "club_cancellation", x.cc.id, { after: { choice: input.choice, via: "LINK" } }));
  return viewResolution(token);
}
