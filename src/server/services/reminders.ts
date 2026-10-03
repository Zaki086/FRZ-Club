// v4 §4.1 (PUSH) reminder jobs, run in the 5-minute batch:
// - NT-11 session reminder: 2 hours before a confirmed court booking, every member player (and a Junior's guardian)
//   gets an in-app + push reminder. Bookings made less than 2 hours before the start get none (they just booked).
// - NT-12 social session reminder: the same for everyone who joined a social play session.
// - NT-13 club-cancellation choice reminders: on day 3 and day 6 after the club cancelled a paid session, while the
//   booker has not chosen (reschedule or refund) and the deadline has not passed — in-app, push, email and WhatsApp
//   (`cancellation_choice_reminder` with the signed `/r/<token>` button). Sent between 09:00 and 20:00 IST only.
// Every reminder is exactly once per event + recipient + channel (dedupe keys in channels.ts EVENT_CATALOGUE).
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { DAY, HOUR, MINUTE, fmtDate, fmtDateTime, fmtRange, istDate, istParts } from "@/lib/time";
import { prisma, withTx } from "../db";
import { SYSTEM } from "../rbac/actor";
import { billDue } from "./bills";
import { memberAudience, notifyGuest, notifyMember } from "./channels";
import { getSettings } from "./settings";
import { signResolutionToken } from "./signed-links";
import { waAmount, waDate, waDateTime, waFirstName, type WaMessage } from "./whatsapp/templates";

/** How long before the start the session reminder goes out. */
export const SESSION_REMINDER_LEAD_MS = 2 * HOUR;
/** Closer to the start than this, a reminder no longer helps (the worker was down): none is sent. */
export const SESSION_REMINDER_CUTOFF_MS = 10 * MINUTE;
/** Days after the club cancellation on which the booker is reminded to choose. */
export const CHOICE_REMINDER_DAYS = [3, 6] as const;
/** Choice reminders go out in daytime only (IST hours, [from, to)). */
export const CHOICE_REMINDER_HOURS = { from: 9, to: 20 } as const;

const dayLabel = (at: Date, now: Date) => (istDate(at) === istDate(now) ? "today" : fmtDate(istDate(at)));

/** NT-11: court bookings that start in the next 2 hours. */
export async function runSessionReminders() {
  const now = clock.now();
  const from = new Date(now.getTime() + SESSION_REMINDER_CUTOFF_MS);
  const to = new Date(now.getTime() + SESSION_REMINDER_LEAD_MS);
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bookings b JOIN court_reservations r ON r.id = b.reservation_id
     WHERE b.status = 'CONFIRMED' AND r.status = 'ACTIVE' AND r.start_at > ${from} AND r.start_at <= ${to}
       AND b.created_at <= r.start_at - interval '2 hours'
     ORDER BY r.start_at, b.id`;
  let sent = 0;
  for (const { id } of due) {
    sent += await withTx(async (tx) => {
      const b = await tx.booking.findUniqueOrThrow({ where: { id }, include: { reservation: { include: { court: true } }, players: true } });
      const bill = b.billId ? await tx.bill.findUnique({ where: { id: b.billId } }) : null;
      const due = bill ? billDue(bill) : 0;
      const when = `${dayLabel(b.reservation.startAt, now)} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`;
      const title = `Reminder: ${b.reservation.court.name}, ${when}`;
      const body = `Your booking ${b.bookingCode} starts at ${fmtRange(b.reservation.startAt, b.reservation.endAt).slice(0, 5)} on ${b.reservation.court.name}.${due > 0 ? ` ${formatINR(due)} is still to pay at the front desk before you play.` : ""} Show your member card at the desk to check in.`;
      const audience = await memberAudience(tx, [b.primaryMemberId, ...b.players.filter((p) => !p.removedAt).map((p) => p.memberId)]);
      let n = 0;
      for (const a of audience) {
        const r = await notifyMember(tx, {
          event: "SESSION_REMINDER", userId: a.userId, memberId: a.memberId, actor: SYSTEM, title, body, link: "/portal/bookings",
          dedupeKey: `session-reminder:${b.id}:${a.memberId}:${a.userId}`, sessionAt: b.reservation.startAt,
        });
        if (r.length) n++;
      }
      return n;
    });
  }
  return { sent };
}

/** NT-12: social play sessions that start in the next 2 hours. */
export async function runSocialSessionReminders() {
  const now = clock.now();
  const sessions = await prisma.socialSession.findMany({
    where: { status: "SCHEDULED", startAt: { gt: new Date(now.getTime() + SESSION_REMINDER_CUTOFF_MS), lte: new Date(now.getTime() + SESSION_REMINDER_LEAD_MS) } },
    include: { participants: { where: { status: "JOINED", memberId: { not: null } } } },
    orderBy: { startAt: "asc" },
  });
  let sent = 0;
  for (const ss of sessions) {
    const joined = ss.participants.filter((p) => p.createdAt.getTime() <= ss.startAt.getTime() - SESSION_REMINDER_LEAD_MS);
    if (!joined.length) continue;
    sent += await withTx(async (tx) => {
      const when = `${dayLabel(ss.startAt, now)} ${fmtRange(ss.startAt, ss.endAt)}`;
      const title = `Reminder: ${ss.title}, ${when}`;
      const body = `${ss.title} starts at ${fmtRange(ss.startAt, ss.endAt).slice(0, 5)}. Check in at the front desk when you arrive.`;
      const audience = await memberAudience(tx, joined.map((p) => p.memberId));
      let n = 0;
      for (const a of audience) {
        const r = await notifyMember(tx, {
          event: "SOCIAL_SESSION_REMINDER", userId: a.userId, memberId: a.memberId, actor: SYSTEM, title, body, link: "/portal/social",
          dedupeKey: `social-reminder:${ss.id}:${a.memberId}:${a.userId}`, sessionAt: ss.startAt,
        });
        if (r.length) n++;
      }
      return n;
    });
  }
  return { sent };
}

/** NT-13: day 3 and day 6 reminders to choose (reschedule or refund) for a club-cancelled paid session. */
export async function runChoiceReminders() {
  const now = clock.now();
  const hour = istParts(now).hour;
  if (hour < CHOICE_REMINDER_HOURS.from || hour >= CHOICE_REMINDER_HOURS.to) return { sent: 0 };
  const pending = await prisma.clubCancellation.findMany({ where: { status: "PENDING_CHOICE", deadlineAt: { gt: now } }, orderBy: { createdAt: "asc" } });
  let sent = 0;
  for (const cc of pending) {
    // The latest step that is due (a missed day 3 is not sent on top of day 6).
    const day = [...CHOICE_REMINDER_DAYS].reverse().find((d) => now.getTime() >= cc.createdAt.getTime() + d * DAY);
    if (!day) continue;
    const step = `D${day}`;
    const made = await withTx(async (tx) => {
      const b = await tx.booking.findUniqueOrThrow({ where: { id: cc.bookingId }, include: { reservation: { include: { court: true } } } });
      const s = await getSettings(tx);
      const slot = `${b.reservation.court.name}, ${fmtDate(istDate(b.reservation.startAt))} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`;
      const deadline = fmtDateTime(cc.deadlineAt);
      const token = signResolutionToken(cc.id, cc.deadlineAt);
      const title = `Still to choose: reschedule or refund ${b.bookingCode} by ${deadline}`;
      const body = `Your booking ${b.bookingCode} (${slot}) was cancelled by the club. Please choose: Reschedule (any free slot in the next ${s.reschedule_window_days} days, no extra charge) or Refund (${formatINR(cc.amountPaid)} in full). With no choice by ${deadline} it is refunded automatically.`;
      const wa = (name: string | null | undefined): WaMessage => ({
        template: "cancellation_choice_reminder",
        vars: { name: waFirstName(name), date: waDate(b.reservation.startAt), deadline: waDateTime(cc.deadlineAt), amount: waAmount(cc.amountPaid) },
        button: { token },
      });
      let n = 0;
      if (b.primaryMemberId) {
        const member = await tx.member.findUnique({ where: { id: b.primaryMemberId }, select: { name: true } });
        for (const a of await memberAudience(tx, [b.primaryMemberId])) {
          const r = await notifyMember(tx, {
            event: "CANCELLATION_CHOICE_REMINDER", userId: a.userId, memberId: a.memberId, actor: SYSTEM, title, body, link: "/portal/bookings",
            dedupeKey: `choice-reminder:${cc.id}:${step}:${a.userId}`, wa: wa(member?.name),
          });
          if (r.length) n++;
        }
      } else if (b.primaryGuestId) {
        const guest = await tx.guest.findUnique({ where: { id: b.primaryGuestId }, select: { name: true } });
        const r = await notifyGuest(tx, {
          event: "CANCELLATION_CHOICE_REMINDER", guestId: b.primaryGuestId, actor: SYSTEM, title, body, link: `/r/${token}`,
          dedupeKey: `choice-reminder:${cc.id}:${step}:${b.primaryGuestId}`, wa: wa(guest?.name),
        });
        if (r.length) n++;
      }
      return n;
    });
    if (made) sent++;
  }
  return { sent };
}
