// Check-in / check-out (plan §5.7 CI-1…CI-4; R-05; E-07, E-13).
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { fmtRange, MINUTE } from "@/lib/time";
import { prisma, withTx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue } from "./bills";
import { getSettings } from "./settings";

export const checkInSchema = z.union([
  z.object({ bookingPlayerId: z.string().min(1) }),
  z.object({ socialParticipantId: z.string().min(1) }),
]);

/** CI-2: allowed from 30 minutes before start until the end, and only when the booking is paid (BK-6). CI-3: writes a visit. */
export async function checkIn(actor: Actor, raw: z.infer<typeof checkInSchema>) {
  assertCan(actor, "checkin");
  const input = checkInSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const now = clock.now();
    let start: Date, end: Date, billId: string | null, label: string, memberId: string | null, guestId: string | null, bookingId: string | null = null;
    if ("bookingPlayerId" in input) {
      const bp = await tx.bookingPlayer.findUnique({ where: { id: input.bookingPlayerId }, include: { booking: { include: { reservation: { include: { court: true } } } } } });
      if (!bp || bp.removedAt) throw new DomainError("NOT_FOUND", "Player was not found on this booking.");
      if (bp.booking.status !== "CONFIRMED") throw new DomainError("VALIDATION_FAILED", `${bp.booking.bookingCode} is ${bp.booking.status.toLowerCase()}.`);
      if (bp.checkedInAt) throw new DomainError("VALIDATION_FAILED", "Already checked in.");
      start = bp.booking.reservation.startAt;
      end = bp.booking.reservation.endAt;
      billId = bp.booking.billId;
      label = `${bp.booking.bookingCode} (${bp.booking.reservation.court.name} ${fmtRange(start, end)})`;
      memberId = bp.memberId;
      guestId = bp.guestId;
      bookingId = bp.bookingId;
    } else {
      const sp = await tx.socialParticipant.findUnique({ where: { id: input.socialParticipantId }, include: { session: true } });
      if (!sp || sp.status !== "JOINED") throw new DomainError("NOT_FOUND", "Participant was not found.");
      if (sp.checkedInAt) throw new DomainError("VALIDATION_FAILED", "Already checked in.");
      start = sp.session.startAt;
      end = sp.session.endAt;
      billId = sp.billId;
      label = `social play “${sp.session.title}” ${fmtRange(start, end)}`;
      memberId = sp.memberId;
      guestId = sp.guestId;
    }
    const opensAt = start.getTime() - s.checkin_window_before_minutes * MINUTE;
    if (now.getTime() < opensAt) throw new DomainError("VALIDATION_FAILED", `Check-in for ${label} opens ${s.checkin_window_before_minutes} minutes before the start.`);
    if (now.getTime() >= end.getTime()) throw new DomainError("VALIDATION_FAILED", `${label} has already ended.`);
    if (billId) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
      const due = billDue(bill);
      if (due > 0) throw new DomainError("PAYMENT_DUE", `${label} has ${formatINR(due)} unpaid. Take the payment before check-in.`, { billId, due });
    }
    if ("bookingPlayerId" in input) await tx.bookingPlayer.update({ where: { id: input.bookingPlayerId }, data: { checkedInAt: now } });
    else await tx.socialParticipant.update({ where: { id: input.socialParticipantId }, data: { checkedInAt: now } });
    const visit = await tx.visit.create({ data: { memberId, guestId, bookingId, checkedInAt: now, byUserId: actorId(actor) } });
    await audit(tx, actor, "checkin", "visit", visit.id, { after: { label, memberId, guestId } });
    return { visitId: visit.id, checkedInAt: now.toISOString() };
  });
}

/** CI-4 / E-13: check-out warns when the member still has an open bar tab. */
export async function checkOut(actor: Actor, memberId: string, opts: { acknowledgeOpenTab?: boolean } = {}) {
  assertCan(actor, "checkin");
  return withTx(async (tx) => {
    const openTab = await tx.tab.findFirst({ where: { memberId, status: "OPEN" } });
    if (openTab && !opts.acknowledgeOpenTab) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: openTab.billId } });
      return { checkedOut: false, openTab: { id: openTab.id, code: openTab.code, due: billDue(bill) } };
    }
    const visit = await tx.visit.findFirst({ where: { memberId, checkedOutAt: null }, orderBy: { checkedInAt: "desc" } });
    if (!visit) throw new DomainError("VALIDATION_FAILED", "This member is not checked in.");
    await tx.visit.update({ where: { id: visit.id }, data: { checkedOutAt: clock.now() } });
    await audit(tx, actor, "checkout", "visit", visit.id, { after: { memberId, openTabAcknowledged: !!openTab } });
    return { checkedOut: true, openTab: null };
  });
}

export async function openVisits(actor: Actor) {
  assertCan(actor, "checkin");
  return prisma.visit.findMany({ where: { checkedOutAt: null }, orderBy: { checkedInAt: "desc" }, take: 100 });
}
