// v3 §7.2 club cancellations (CC-1…CC-8). A Manager/Owner closes courts for a time range with a reason. In one
// transaction every affected booking becomes CANCELLED_BY_CLUB (reservation released, daily counts freed), social
// sessions on those courts are cancelled and refunded, and the range is blocked with MAINTENANCE reservations (the
// exclusion constraint keeps it free). A paid booking gets a resolution record PENDING_CHOICE: the member or the desk
// reschedules it (once, within `reschedule_window_days`, no extra charge) or takes a refund (approved, ignoring the
// 2-hour rule); with no choice after `resolution_deadline_days` it is refunded automatically. Unpaid ones are just
// cancelled.
import { Prisma, type Bill } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, fmtDate, fmtDateTime, fmtRange, istDate, istToUtc, isValidDateStr } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, SYSTEM, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { closeBill, lockBill, netPaid } from "./bills";
import { createBookingTx, insertReservation } from "./booking";
import { memberAudience, notifyGuest, notifyMember } from "./channels";
import { refundTx } from "./payments";
import { getSettings } from "./settings";
import { signResolutionToken } from "./signed-links";
import { cancelSocialSessionTx, notifySocialCancelled } from "./social";
import { waAmount, waDate, waDateTime, waFirstName, waSession, waTime, type WaMessage } from "./whatsapp/templates";

export const CLOSURE_REASONS = ["MAINTENANCE", "WET_COURT", "WEATHER", "EVENT", "OTHER"] as const;
export const CLOSURE_REASON_LABEL: Record<(typeof CLOSURE_REASONS)[number], string> = {
  MAINTENANCE: "Maintenance", WET_COURT: "Wet court", WEATHER: "Weather", EVENT: "Club event", OTHER: "Closed",
};

export const closureSchema = z.object({
  courtIds: z.array(z.string().min(1)).min(1, "Choose at least one court.").max(50),
  date: z.string().refine(isValidDateStr, "date must be YYYY-MM-DD"),
  startTime: z.string().regex(/^\d{2}:(00|30)$/, "start on :00 or :30"),
  endTime: z.string().regex(/^\d{2}:(00|30)$/, "end on :00 or :30"),
  reason: z.enum(CLOSURE_REASONS),
  note: z.string().trim().max(300).default(""),
});

type Affected = {
  bookings: Array<{ id: string; code: string; court: string; courtId: string; startAt: Date; endAt: Date; reservationId: string; billId: string | null; paid: number; due: number; primary: string; players: string[] }>;
  social: Array<{ id: string; title: string; startAt: Date; endAt: Date; participants: Array<{ name: string; paid: number }> }>;
};

function bounds(input: z.infer<typeof closureSchema>) {
  const start = istToUtc(input.date, input.startTime);
  const end = istToUtc(input.date, input.endTime);
  if (end <= start) throw new DomainError("INVALID_SLOT", "The closure must end after it starts.");
  if (end.getTime() <= clock.now().getTime()) throw new DomainError("IN_PAST", "That time has already passed.");
  return { start, end };
}

async function findAffected(tx: Tx | typeof prisma, courtIds: string[], start: Date, end: Date, lock = false): Promise<Affected> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bookings b JOIN court_reservations r ON r.id = b.reservation_id
     WHERE r.court_id = ANY(${courtIds}::text[]) AND r.status = 'ACTIVE' AND b.status = 'CONFIRMED' AND r.period && tstzrange(${start}, ${end}, '[)')
     ORDER BY r.start_at ${lock ? Prisma.sql`FOR UPDATE OF b` : Prisma.empty}`;
  const bookings: Affected["bookings"] = [];
  for (const { id } of rows) {
    const b = await tx.booking.findUniqueOrThrow({ where: { id }, include: { reservation: { include: { court: true } }, players: true } });
    const bill = b.billId ? await tx.bill.findUnique({ where: { id: b.billId } }) : null;
    const names = await playerNames(tx, b.players.filter((p) => !p.removedAt));
    bookings.push({
      id: b.id, code: b.bookingCode, court: b.reservation.court.name, courtId: b.reservation.courtId, startAt: b.reservation.startAt, endAt: b.reservation.endAt,
      reservationId: b.reservationId, billId: b.billId, paid: bill ? netPaid(bill) : 0, due: bill && !bill.closedAt ? Math.max(0, bill.total - netPaid(bill)) : 0,
      primary: names[0] ?? "", players: names,
    });
  }
  const sessions = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ss.id FROM social_sessions ss JOIN social_session_courts sc ON sc.session_id = ss.id JOIN court_reservations r ON r.id = sc.reservation_id
     WHERE r.court_id = ANY(${courtIds}::text[]) AND r.status = 'ACTIVE' AND ss.status = 'SCHEDULED' AND r.period && tstzrange(${start}, ${end}, '[)')`;
  const social: Affected["social"] = [];
  for (const { id } of sessions) {
    const ss = await tx.socialSession.findUniqueOrThrow({ where: { id }, include: { participants: true } });
    const joined = ss.participants.filter((p) => p.status === "JOINED");
    const names = await playerNames(tx, joined);
    const paid = await Promise.all(joined.map(async (p) => (p.billId ? netPaid(await tx.bill.findUniqueOrThrow({ where: { id: p.billId } })) : 0)));
    social.push({ id, title: ss.title, startAt: ss.startAt, endAt: ss.endAt, participants: joined.map((_, i) => ({ name: names[i], paid: paid[i] })) });
  }
  return { bookings, social };
}

async function playerNames(tx: Tx | typeof prisma, ps: Array<{ memberId: string | null; guestId: string | null }>) {
  const members = await tx.member.findMany({ where: { id: { in: ps.map((p) => p.memberId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const guests = await tx.guest.findMany({ where: { id: { in: ps.map((p) => p.guestId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return ps.map((p) => (p.memberId ? members.find((m) => m.id === p.memberId)?.name : guests.find((g) => g.id === p.guestId)?.name) ?? "?");
}

/** CC-1: what closing these courts would cancel, with the amounts paid. Nothing is changed. */
export async function previewClosure(actor: Actor, raw: z.input<typeof closureSchema>) {
  assertCan(actor, "maintenance.manage");
  const input = closureSchema.parse(raw);
  const { start, end } = bounds(input);
  const a = await findAffected(prisma, input.courtIds, start, end);
  return {
    start, end,
    bookings: a.bookings.map((b) => ({ id: b.id, code: b.code, court: b.court, courtId: b.courtId, startAt: b.startAt, endAt: b.endAt, paid: b.paid, due: b.due, primary: b.primary, players: b.players })),
    social: a.social,
    totals: {
      bookings: a.bookings.length, paidBookings: a.bookings.filter((b) => b.paid > 0).length,
      paid: a.bookings.reduce((x, b) => x + b.paid, 0) + a.social.reduce((x, s) => x + s.participants.reduce((y, p) => y + p.paid, 0), 0),
      socialParticipants: a.social.reduce((x, s) => x + s.participants.length, 0),
    },
  };
}

/** The closed range minus any maintenance already there, per court (so the new blocks never overlap old ones). */
async function blockRange(tx: Tx, actor: Actor, courtId: string, start: Date, end: Date, note: string, closureId: string) {
  const court = await tx.court.findUniqueOrThrow({ where: { id: courtId } });
  const existing = await tx.$queryRaw<{ start_at: Date; end_at: Date }[]>`
    SELECT start_at, end_at FROM court_reservations WHERE court_id = ${courtId} AND status = 'ACTIVE' AND kind = 'MAINTENANCE'
       AND period && tstzrange(${start}, ${end}, '[)') ORDER BY start_at`;
  let cursor = start;
  const pieces: Array<[Date, Date]> = [];
  for (const e of existing) {
    if (e.start_at > cursor) pieces.push([cursor, e.start_at < end ? e.start_at : end]);
    if (e.end_at > cursor) cursor = e.end_at;
  }
  if (cursor < end) pieces.push([cursor, end]);
  for (const [a, b] of pieces) {
    const id = await insertReservation(tx, court, a, b, "MAINTENANCE", actorId(actor), note);
    await tx.courtReservation.update({ where: { id }, data: { closureId } });
  }
  return pieces.length;
}

/** CC-2/CC-3/CC-7: close the courts, cancel what is on them, notify everyone. One transaction. */
export async function closeCourts(actor: Actor, raw: z.input<typeof closureSchema>) {
  assertCan(actor, "maintenance.manage");
  const input = closureSchema.parse(raw);
  const { start, end } = bounds(input);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const courts = await tx.court.findMany({ where: { id: { in: input.courtIds } } });
    if (courts.length !== new Set(input.courtIds).size) throw new DomainError("NOT_FOUND", "A court was not found.");
    const label = CLOSURE_REASON_LABEL[input.reason];
    const why = input.note ? `${label}: ${input.note}` : label;
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('court_closure_code_seq') AS n`;
    const closure = await tx.courtClosure.create({
      data: { code: `CL-${String(Number(n)).padStart(6, "0")}`, courtIds: input.courtIds, startAt: start, endAt: end, reason: input.reason, note: input.note, createdBy: actorId(actor) },
    });
    const affected = await findAffected(tx, input.courtIds, start, end, true);
    const now = clock.now();
    const deadline = new Date(now.getTime() + s.resolution_deadline_days * 86_400_000);
    let pending = 0;
    for (const b of affected.bookings) {
      await tx.courtReservation.update({ where: { id: b.reservationId }, data: { status: "CANCELLED" } });
      await tx.booking.update({ where: { id: b.id }, data: { status: "CANCELLED_BY_CLUB", cancelledAt: now, cancelledBy: actorId(actor), cancelReason: `Closed by the club — ${why}` } });
      let resolution: string | null = null;
      if (b.billId) {
        const bill = await lockBill(tx, b.billId);
        if (netPaid(bill) > 0) {
          const cc = await tx.clubCancellation.create({ data: { closureId: closure.id, bookingId: b.id, billId: bill.id, amountPaid: netPaid(bill), deadlineAt: deadline } });
          resolution = cc.id;
          pending++;
        }
        // Nothing more is owed for a session the club cancelled (CC-7); what was paid waits for the choice.
        await closeBill(tx, bill.id, `Cancelled by the club (${closure.code})`, now);
      }
      await audit(tx, actor, "booking.cancel_by_club", "booking", b.id, { before: { status: "CONFIRMED" }, after: { status: "CANCELLED_BY_CLUB", closure: closure.code, paid: b.paid, resolution: resolution ? "PENDING_CHOICE" : "NOTHING_OWED" }, reason: why });
      await notifyCancelled(tx, actor, b, why, resolution ? { paid: b.paid, deadline, windowDays: s.reschedule_window_days, ccId: resolution } : null);
    }
    for (const ss of affected.social) {
      const r = await cancelSocialSessionTx(tx, actor, ss.id, `Closed by the club — ${why}`, { byClub: true });
      await notifySocialCancelled(tx, actor, r, why);
    }
    let blocks = 0;
    for (const c of courts) blocks += await blockRange(tx, actor, c.id, start, end, `${closure.code} · ${why}`, closure.id);
    await audit(tx, actor, "courts.close", "court_closure", closure.id, {
      after: { code: closure.code, courts: courts.map((c) => c.name), start, end, reason: input.reason, bookings: affected.bookings.length, social: affected.social.length, pendingChoice: pending },
      reason: why,
    });
    return { closureId: closure.id, code: closure.code, cancelledBookings: affected.bookings.length, pendingChoice: pending, cancelledSocial: affected.social.length, blocks };
  });
}

/**
 * CC-3: the booker and every member player (and a Junior's guardian) hear it on every channel; guests hear it by email
 * and on their phone. The booker's message carries the choice: reschedule or refund in My bookings, by the deadline.
 */
async function notifyCancelled(tx: Tx, actor: Actor, b: Affected["bookings"][number], why: string, paid: { paid: number; deadline: Date; windowDays: number; ccId: string } | null) {
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: b.id }, include: { players: true } });
  // v4 §5.2/§5.5: every affected person gets one WhatsApp. Whoever chooses (the booker of a paid booking, or a Junior
  // booker's guardian) gets club_session_cancelled with the "Choose option" button → /r/<token> (signed, valid until
  // the deadline; it acts as the booker, so only they get it — CC-4/CC-5: only the booker or the desk chooses).
  // Everyone else (other players, an unpaid booking) gets booking_cancelled_refund saying what happens to the money.
  const court = await tx.court.findUnique({ where: { id: b.courtId }, select: { sport: true } });
  const waFor = (name: string | null | undefined, chooses: boolean): WaMessage => paid && chooses ? {
    template: "club_session_cancelled",
    vars: { name: waFirstName(name), session: waSession(court?.sport, b.court), date: waDate(b.startAt), time: waTime(b.startAt), reason: why, amount: waAmount(paid.paid), deadline: waDateTime(paid.deadline) },
    button: { token: signResolutionToken(paid.ccId, paid.deadline) },
  } : {
    template: "booking_cancelled_refund",
    vars: { name: waFirstName(name), booking: b.code, date: waDate(b.startAt), time: waTime(b.startAt), refund: paid ? "the person who booked chooses a new time or a refund" : "nothing was charged" },
    button: { ref: b.code },
  };
  const s = await getSettings(tx);
  const slot = `${b.court}, ${fmtDate(istDate(b.startAt))} ${fmtRange(b.startAt, b.endAt)}`;
  const title = `Cancelled by the club: ${slot}`;
  const what = `Your booking ${b.code} (${slot}) is cancelled by the club. Reason: ${why}.`;
  const choice = paid
    ? ` You paid ${formatINR(paid.paid)}. Choose in My bookings by ${fmtDateTime(paid.deadline)}: Reschedule (any free slot in the next ${paid.windowDays} days, no extra charge) or Refund (${formatINR(paid.paid)} in full). With no choice by then it is refunded automatically.`
    : " Nothing is owed.";
  const audience = await memberAudience(tx, [booking.primaryMemberId, ...booking.players.filter((p) => !p.removedAt).map((p) => p.memberId)]);
  for (const a of audience) {
    const isBooker = a.memberId === booking.primaryMemberId;
    const recipient = await tx.user.findUnique({ where: { id: a.userId }, select: { name: true } });
    await notifyMember(tx, {
      event: "BOOKING_CANCELLED_BY_CLUB", userId: a.userId, memberId: a.memberId, actor, title, sessionAt: b.startAt,
      body: `${what}${isBooker ? choice : " The person who booked chooses a new time or a refund."}`,
      link: "/portal/bookings", dedupeKey: `club-cancel:${b.id}:${a.memberId}${a.userId === (audience.find((x) => x.memberId === a.memberId)?.userId) ? "" : `:${a.userId}`}`,
      params: [b.primary, b.court, slot, why, "/portal/bookings"],
      wa: waFor(recipient?.name, isBooker),
    });
  }
  const call = s.club.phone ? ` Call the club on ${s.club.phone}` : " Reply or call the club";
  const guestIds = [...new Set([booking.primaryGuestId, ...booking.players.filter((p) => !p.removedAt).map((p) => p.guestId)].filter((x): x is string => !!x))];
  for (const g of guestIds) {
    const guest = await tx.guest.findUnique({ where: { id: g }, select: { name: true } });
    await notifyGuest(tx, {
      event: "BOOKING_CANCELLED_BY_CLUB", guestId: g, title, actor, dedupeKey: `club-cancel:${b.id}:${g}`, params: [b.primary, b.court, slot, why, ""],
      wa: waFor(guest?.name, g === booking.primaryGuestId),
      body: `${what}${g === booking.primaryGuestId && paid ? ` You paid ${formatINR(paid.paid)}.${call} by ${fmtDateTime(paid.deadline)} to move it to another time (no extra charge) or get a refund; otherwise it is refunded automatically.` : ""}`,
    });
  }
}

// ───────── resolution: reschedule or refund (CC-4, CC-5, CC-6) ─────────

async function lockResolution(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM club_cancellations WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Cancelled booking was not found.");
  const cc = await tx.clubCancellation.findUniqueOrThrow({ where: { id } });
  if (cc.status !== "PENDING_CHOICE") throw new DomainError("ORDER_STATE_INVALID", `This booking was already ${cc.status === "RESCHEDULED" ? "rescheduled" : "refunded"}.`);
  return cc;
}

/** The booker (portal) or staff who handle bookings. */
async function assertMayResolve(tx: Tx, actor: Actor, bookingId: string) {
  if (actor.kind === "SYSTEM" || can(actor, "bookings.any")) return;
  const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
  if (actor.kind === "USER" && actor.role === "MEMBER" && b.primaryMemberId && b.primaryMemberId === actor.memberId) return;
  throw new DomainError("FORBIDDEN", "Not allowed: only the person who booked, or the front desk, can choose.");
}

const b0 = (x: string | null | undefined) => x ?? "";
const via = (actor: Actor) => (actor.kind !== "USER" ? "AUTO" : actor.role === "MEMBER" ? "MEMBER" : "STAFF");

export const rescheduleSchema = z.object({ courtId: z.string().min(1), date: z.string().refine(isValidDateStr), startTime: z.string().regex(/^\d{2}:\d{2}$/) });

/** CC-4: one move to a free slot within the window; every booking rule applies; nothing more to pay. */
export async function rescheduleClubCancellation(actor: Actor, id: string, raw: z.infer<typeof rescheduleSchema>) {
  const input = rescheduleSchema.parse(raw);
  return withTx(async (tx) => {
    const cc = await lockResolution(tx, id);
    await assertMayResolve(tx, actor, cc.bookingId);
    const s = await getSettings(tx);
    const old = await tx.booking.findUniqueOrThrow({ where: { id: cc.bookingId }, include: { players: true } });
    const players = old.players.filter((p) => !p.removedAt);
    const primaryIndex = Math.max(0, players.findIndex((p) => (old.primaryMemberId ? p.memberId === old.primaryMemberId : p.guestId === old.primaryGuestId)));
    const isMember = actor.kind === "USER" && actor.role === "MEMBER";
    const r = await createBookingTx(tx, actor, {
      courtId: input.courtId, date: input.date, startTime: input.startTime, primaryIndex,
      players: players.map((p) => (p.memberId ? { memberId: p.memberId } : { guestId: p.guestId! })),
      channel: isMember ? "ONLINE_MEMBER" : "FRONT_DESK", payment: { kind: "LATER" }, note: `Moved from ${old.bookingCode} (club cancellation)`,
    }, { reschedule: { fromCode: old.bookingCode, windowDays: s.reschedule_window_days } });
    await tx.clubCancellation.update({ where: { id }, data: { status: "RESCHEDULED", newBookingId: r.bookingId, resolvedBy: actorId(actor), resolvedVia: via(actor), resolvedAt: clock.now() } });
    await audit(tx, actor, "club_cancellation.rescheduled", "club_cancellation", id, { before: { status: "PENDING_CHOICE" }, after: { status: "RESCHEDULED", from: old.bookingCode, to: r.bookingCode, paidBefore: cc.amountPaid, newPrice: 0 } });
    await notifyRescheduled(tx, actor, cc.id, old.id, r.bookingId);
    return { id, status: "RESCHEDULED", booking: r };
  });
}

/** CC-4: everyone on the moved booking hears the new court and time (members on every channel, guests by email/phone). */
async function notifyRescheduled(tx: Tx, actor: Actor, ccId: string, oldId: string, newId: string) {
  const load = (id: string) => tx.booking.findUniqueOrThrow({ where: { id }, include: { reservation: { include: { court: true } }, players: true } });
  const [old, now] = await Promise.all([load(oldId), load(newId)]);
  const slot = (b: typeof old) => `${b.reservation.court.name}, ${fmtDate(istDate(b.reservation.startAt))} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`;
  const title = `Moved: your booking is now ${slot(now)}`;
  const body = `${old.bookingCode} (${slot(old)}, cancelled by the club) is moved to ${slot(now)} — new booking ${now.bookingCode}. Already paid: nothing more to pay.`;
  const players = now.players.filter((p) => !p.removedAt);
  const audience = await memberAudience(tx, [now.primaryMemberId, ...players.map((p) => p.memberId)]);
  const names = await playerNames(tx, [...audience.map((a) => ({ memberId: a.memberId, guestId: null })), ...players.filter((p) => p.guestId).map((p) => ({ memberId: null, guestId: p.guestId }))]);
  const params = (name: string) => [name, old.bookingCode, now.reservation.court.name, fmtDateTime(now.reservation.startAt)];
  // v4 §5.2 booking_rescheduled: the button opens portal/bookings/<new booking code>.
  const wa = (name: string | null | undefined): WaMessage => ({
    template: "booking_rescheduled",
    vars: { name: waFirstName(name), court: now.reservation.court.name, time: waTime(now.reservation.startAt), date: waDate(now.reservation.startAt), booking: now.bookingCode },
    button: { booking: now.bookingCode },
  });
  for (const [i, a] of audience.entries()) {
    const recipient = await tx.user.findUnique({ where: { id: a.userId }, select: { name: true } });
    await notifyMember(tx, {
      event: "BOOKING_RESCHEDULED", userId: a.userId, memberId: a.memberId, actor, title, body, link: "/portal/bookings",
      dedupeKey: `club-reschedule:${ccId}:${a.memberId}:${a.userId}`, params: params(names[i]), wa: wa(recipient?.name ?? names[i]),
    });
  }
  for (const g of [...new Set([now.primaryGuestId, ...players.map((p) => p.guestId)].filter((x): x is string => !!x))]) {
    const guest = await tx.guest.findUnique({ where: { id: g }, select: { name: true } });
    await notifyGuest(tx, { event: "BOOKING_RESCHEDULED", guestId: g, title, body, actor, dedupeKey: `club-reschedule:${ccId}:${g}`, params: params(guest?.name ?? ""), wa: wa(guest?.name) });
  }
}

async function refundTxFor(tx: Tx, actor: Actor, cc: { id: string; billId: string; bookingId: string; deadlineAt: Date }, policy: string) {
  const bill: Bill = await lockBill(tx, cc.billId);
  const amount = netPaid(bill);
  const old = await tx.booking.findUniqueOrThrow({ where: { id: cc.bookingId }, include: { reservation: { include: { court: true } } } });
  const auto = policy === "CC-6";
  // A refund the member chose is confirmed by the refund messages; the automatic one (CC-6) gets its own message below.
  const r = amount > 0
    ? await refundTx(tx, actor, bill.id, amount, { reason: `${old.bookingCode} cancelled by the club`, category: "CLUB_CANCELLATION", policy, deskLater: true, quiet: auto })
    : null;
  if (auto && r) {
    const slot = `${old.reservation.court.name}, ${fmtDate(istDate(old.reservation.startAt))} ${fmtRange(old.reservation.startAt, old.reservation.endAt)}`;
    const req = await tx.refundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
    const how = r.pending
      ? `${formatINR(r.pending)} is ready at the front desk: collect it on your next visit (say refund ${req.code})${r.pending < amount ? `; ${formatINR(amount - r.pending)} has gone back to the card or account you paid with` : ""}.`
      : "It has gone back to the card or account you paid with.";
    const title = `Refunded: ${formatINR(amount)} for ${old.bookingCode}`;
    const body = `No new time was chosen for ${old.bookingCode} (${slot}, cancelled by the club) by ${fmtDateTime(cc.deadlineAt)}, so it was refunded in full: ${formatINR(amount)}. ${how}`;
    const params = [b0(old.primaryMemberId ? (await tx.member.findUnique({ where: { id: old.primaryMemberId }, select: { name: true } }))?.name : (await tx.guest.findUnique({ where: { id: old.primaryGuestId ?? "" }, select: { name: true } }))?.name), old.bookingCode, formatINR(amount), r.pending ? "at the front desk" : "back to your card or account"];
    const audience = await memberAudience(tx, [old.primaryMemberId]);
    for (const [i, a] of audience.entries()) {
      await notifyMember(tx, { event: "BOOKING_AUTO_REFUNDED", userId: a.userId, memberId: a.memberId, actor, title, body, link: "/portal/bookings", dedupeKey: `club-auto-refund:${cc.id}${i ? `:${a.userId}` : ""}`, params });
    }
    if (!old.primaryMemberId && old.primaryGuestId) {
      await notifyGuest(tx, { event: "BOOKING_AUTO_REFUNDED", guestId: old.primaryGuestId, title, body, actor, dedupeKey: `club-auto-refund:${cc.id}`, params });
    }
  }
  await tx.clubCancellation.update({ where: { id: cc.id }, data: { status: "REFUNDED", refundRequestId: r?.requestId ?? null, resolvedBy: actor.kind === "USER" ? actorId(actor) : null, resolvedVia: via(actor), resolvedAt: clock.now() } });
  await audit(tx, actor, "club_cancellation.refunded", "club_cancellation", cc.id, { before: { status: "PENDING_CHOICE" }, after: { status: "REFUNDED", amount, pending: r?.pending ?? 0, policy } });
  return { amount, pending: r?.pending ?? 0, requestId: r?.requestId ?? null };
}

/** CC-5: a full refund as an approved request (the 2-hour rule does not apply); online money goes straight back. */
export async function refundClubCancellation(actor: Actor, id: string) {
  return withTx((tx) => refundClubCancellationTx(tx, actor, id));
}

export async function refundClubCancellationTx(tx: Tx, actor: Actor, id: string) {
  const cc = await lockResolution(tx, id);
  await assertMayResolve(tx, actor, cc.bookingId);
  const r = await refundTxFor(tx, actor, cc, "CC-5");
  const req = r.requestId ? await tx.refundRequest.findUniqueOrThrow({ where: { id: r.requestId } }) : null;
  return { id: req?.id ?? id, status: req?.status ?? "COMPLETED", amount: r.amount, resolution: "REFUNDED" as const };
}

/** CC-6 (daily job): no choice by the deadline → refunded automatically. */
export async function autoRefundClubCancellations() {
  const due = await prisma.clubCancellation.findMany({ where: { status: "PENDING_CHOICE", deadlineAt: { lte: clock.now() } }, select: { id: true } });
  let refunded = 0;
  for (const { id } of due) {
    await withTx(async (tx) => {
      const cc = await lockResolution(tx, id);
      await refundTxFor(tx, SYSTEM, cc, "CC-6");
    });
    refunded++;
  }
  return { refunded };
}

/** For the portal and the booking detail: the open choice on a club-cancelled booking. */
export async function resolutionFor(bookingId: string) {
  const cc = await prisma.clubCancellation.findUnique({ where: { bookingId } });
  if (!cc) return null;
  const s = await getSettings();
  return { id: cc.id, status: cc.status, amountPaid: cc.amountPaid, deadlineAt: cc.deadlineAt, lastDay: addDays(istDate(clock.now()), s.reschedule_window_days), newBookingId: cc.newBookingId, refundRequestId: cc.refundRequestId };
}

/** CC-8: how many paid club-cancelled bookings still wait for a choice. */
export async function pendingClubCancellations() {
  return prisma.clubCancellation.count({ where: { status: "PENDING_CHOICE" } });
}
