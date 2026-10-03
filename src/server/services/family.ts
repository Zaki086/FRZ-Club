// Completion pass P1 (guardian): a member who is the guardian of Junior / under-18 members sees them in the portal —
// membership status, upcoming bookings, the member card — and receives their reminders.
import { clock } from "@/lib/clock";
import { addDays, istDate, istDayRange } from "@/lib/time";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { effectiveStatus } from "./membership";

export async function myFamily(actor: Actor) {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Not allowed: family is for members.");
  const juniors = await prisma.member.findMany({ where: { guardianMemberId: actor.memberId, anonymisedAt: null }, orderBy: { name: "asc" } });
  const today = istDate(clock.now());
  const [from] = istDayRange(today);
  const [, to] = istDayRange(addDays(today, 14));
  const out = [];
  for (const j of juniors) {
    const players = await prisma.bookingPlayer.findMany({
      where: { memberId: j.id, removedAt: null, booking: { status: "CONFIRMED", reservation: { startAt: { gte: from, lt: to } } } },
      include: { booking: { include: { reservation: { include: { court: true } } } } },
      orderBy: { booking: { reservation: { startAt: "asc" } } },
    });
    out.push({
      id: j.id, name: j.name, memberCode: j.memberCode, status: await effectiveStatus(j.id),
      bookings: players.map((p) => ({ id: p.booking.id, code: p.booking.bookingCode, court: p.booking.reservation.court.name, startAt: p.booking.reservation.startAt, endAt: p.booking.reservation.endAt })),
    });
  }
  return out;
}

/** User ids of the guardians of these members (to copy them on reminders). */
export async function guardianUserIds(memberIds: string[]): Promise<string[]> {
  if (!memberIds.length) return [];
  const rows = await prisma.member.findMany({ where: { id: { in: memberIds }, guardianMemberId: { not: null } }, select: { guardianMemberId: true } });
  const guardians = await prisma.member.findMany({ where: { id: { in: rows.map((r) => r.guardianMemberId!) } }, select: { userId: true } });
  return guardians.map((g) => g.userId).filter((x): x is string => !!x);
}
