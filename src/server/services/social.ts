// Social play (plan §5.6 SP-1…SP-4; R-15; E-22). One SOCIAL reservation holds each court, so R-16 still holds;
// many participants share it inside.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, dbDate, fmtDate, fmtRange, HOUR, istDate, istToUtc, isValidDateStr, MINUTE, timeToMinutes, istTime } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue, closeBill, createBill, netPaid } from "./bills";
import { assertDailyLimit, assertNoTimeConflict, findMemberRef, insertReservation, paymentChoiceSchema, playerInputSchema, type PlayerInput } from "./booking";
import { findOrCreateGuest } from "./guests";
import { idempotent } from "./idempotency";
import { notifyGuest, notifyMember, memberAudience } from "./channels";
import { notify } from "./notifications";
import { recordPaymentTx, refundTx, startOnlinePaymentTx } from "./payments";
import { entitlementsFor, quoteSocial } from "./pricing";
import { getSettings } from "./settings";
import { normalisePhone } from "@/lib/codes";
import { waAmount, waDate, waFirstName, waTime, type WaMessage } from "./whatsapp/templates";

export const createSessionSchema = z.object({
  title: z.string().trim().min(3).max(80).default("Friday Social"),
  courtIds: z.array(z.string().min(1)).min(1),
  date: z.string().refine(isValidDateStr, "date must be YYYY-MM-DD"),
  startTime: z.string().regex(/^\d{2}:(00|30)$/, "start on :00 or :30"),
  endTime: z.string().regex(/^\d{2}:(00|30)$/, "end on :00 or :30"),
  capacityPerCourt: z.number().int().min(1).max(40).optional(),
  repeatWeeks: z.number().int().min(1).max(26).default(1),
});

/** SP-1/SP-2/E-22: create a session (optionally weekly for N weeks). All-or-nothing; conflicts are listed. */
export async function createSocialSession(actor: Actor, raw: z.input<typeof createSessionSchema>, outer?: Tx) {
  assertCan(actor, "social.manage");
  const input = createSessionSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const startMin = timeToMinutes(input.startTime);
    const endMin = timeToMinutes(input.endTime);
    if (endMin - startMin < 60) throw new DomainError("INVALID_SLOT", "A social session lasts at least 60 minutes.");
    if (startMin < timeToMinutes(s.opening_hours.open) || endMin > timeToMinutes(s.opening_hours.close)) {
      throw new DomainError("INVALID_SLOT", `Social play must be within opening hours ${s.opening_hours.open}–${s.opening_hours.close}.`);
    }
    const courts = await tx.court.findMany({ where: { id: { in: input.courtIds } } });
    if (courts.length !== new Set(input.courtIds).size) throw new DomainError("NOT_FOUND", "One of the courts was not found.");
    const seriesId = input.repeatWeeks > 1 ? `series_${globalThis.crypto.randomUUID().slice(0, 8)}` : null;
    // SP-2: list every conflicting booking before inserting anything.
    const conflicts: string[] = [];
    for (let w = 0; w < input.repeatWeeks; w++) {
      const date = addDays(input.date, 7 * w);
      const start = istToUtc(date, input.startTime);
      const end = istToUtc(date, input.endTime);
      if (start.getTime() <= clock.now().getTime()) throw new DomainError("IN_PAST", `${fmtDate(date)} ${input.startTime} is in the past.`);
      for (const c of courts) {
        const rows = await tx.$queryRaw<{ kind: string; start_at: Date; end_at: Date; booking_code: string | null; title: string | null }[]>`
          SELECT r.kind::text AS kind, r.start_at, r.end_at, b.booking_code, ss.title FROM court_reservations r
            LEFT JOIN bookings b ON b.reservation_id = r.id
            LEFT JOIN social_session_courts sc ON sc.reservation_id = r.id LEFT JOIN social_sessions ss ON ss.id = sc.session_id
           WHERE r.court_id = ${c.id} AND r.status <> 'CANCELLED' AND r.period && tstzrange(${start}, ${end}, '[)')`;
        for (const r of rows) {
          conflicts.push(`${c.name} ${fmtDate(date)} ${fmtRange(r.start_at, r.end_at)} ${r.kind === "REGULAR" ? r.booking_code : r.kind === "SOCIAL" ? `social “${r.title}”` : "maintenance"}`);
        }
      }
    }
    if (conflicts.length) {
      throw new DomainError("SLOT_TAKEN", `Social play can't be created over existing reservations: ${conflicts.join("; ")}.`, { conflicts });
    }
    const created = [];
    for (let w = 0; w < input.repeatWeeks; w++) {
      const date = addDays(input.date, 7 * w);
      const start = istToUtc(date, input.startTime);
      const end = istToUtc(date, input.endTime);
      const session = await tx.socialSession.create({
        data: {
          title: input.title, seriesId, date: dbDate(date), startAt: start, endAt: end,
          capacityPerCourt: input.capacityPerCourt ?? s.social_default_capacity, createdBy: actorId(actor),
        },
      });
      for (const c of courts) {
        const reservationId = await insertReservation(tx, c, start, end, "SOCIAL", actorId(actor));
        await tx.socialSessionCourt.create({ data: { sessionId: session.id, courtId: c.id, reservationId } });
      }
      await audit(tx, actor, "social.create", "social_session", session.id, { after: { title: input.title, date, start: input.startTime, end: input.endTime, courts: courts.map((c) => c.name) } });
      created.push({ id: session.id, date });
    }
    return { seriesId, sessions: created };
  }, outer);
}

export async function cancelSocialSession(actor: Actor, sessionId: string, reason: string) {
  assertCan(actor, "social.manage");
  return withTx(async (tx) => {
    const r = await cancelSocialSessionTx(tx, actor, sessionId, reason);
    await notifySocialCancelled(tx, actor, r, reason);
    return r;
  });
}

/**
 * Everyone who had joined a session the club cancelled hears it on every channel (members, a Junior's guardian) or by
 * email/phone (guests): which session, when, why, and what happens to their money.
 */
export async function notifySocialCancelled(tx: Tx, actor: Actor, r: Awaited<ReturnType<typeof cancelSocialSessionTx>>, why: string) {
  const when = `${fmtDate(istDate(r.startAt))} ${fmtRange(r.startAt, r.endAt)}`;
  const title = `Cancelled by the club: ${r.title}, ${when}`;
  for (const p of r.participants) {
    const money = p.refunded
      ? p.pending
        ? ` Your ${formatINR(p.refunded)} is refunded: collect ${formatINR(p.pending)} at the front desk on your next visit${p.refunded > p.pending ? `; ${formatINR(p.refunded - p.pending)} goes back to the card or account you paid with` : ""}.`
        : ` Your ${formatINR(p.refunded)} has been refunded to the card or account you paid with.`
      : " Nothing is owed.";
    const body = `“${r.title}” on ${when} is cancelled. Reason: ${why}.${money}`;
    const params = [title, r.title, when, why, "/portal/social"];
    // v4 §5.2 booking_cancelled_refund: the session and what happens to the money; the button opens the refund.
    const refundCode = p.refundRequestId ? (await tx.refundRequest.findUnique({ where: { id: p.refundRequestId }, select: { code: true } }))?.code ?? null : null;
    const outcome = p.refunded
      ? p.pending
        ? `₹${waAmount(p.pending)} to collect at the front desk${p.refunded > p.pending ? `, ₹${waAmount(p.refunded - p.pending)} refunded` : ""}`
        : `₹${waAmount(p.refunded)} refunded`
      : "nothing was charged";
    const wa = (name: string | null | undefined): WaMessage => ({
      template: "booking_cancelled_refund",
      vars: { name: waFirstName(name), booking: r.title, date: waDate(r.startAt), time: waTime(r.startAt), refund: outcome },
      button: { ref: refundCode ?? r.sessionId },
    });
    if (p.memberId) {
      const audience = await memberAudience(tx, [p.memberId]);
      for (const [i, a] of audience.entries()) {
        const recipient = await tx.user.findUnique({ where: { id: a.userId }, select: { name: true } });
        await notifyMember(tx, { event: "BOOKING_CANCELLED_BY_CLUB", userId: a.userId, memberId: a.memberId, actor, title, body, sessionAt: r.startAt, link: "/portal/social", dedupeKey: `club-cancel-social:${p.id}${i ? `:${a.userId}` : ""}`, params, wa: wa(recipient?.name) });
      }
    } else if (p.guestId) {
      const guest = await tx.guest.findUnique({ where: { id: p.guestId }, select: { name: true } });
      await notifyGuest(tx, { event: "BOOKING_CANCELLED_BY_CLUB", guestId: p.guestId, title, body, dedupeKey: `club-cancel-social:${p.id}`, params, actor, wa: wa(guest?.name) });
    }
  }
}

/**
 * Cancel a scheduled session: paid participants are refunded in full (a club-cancellation policy refund), bills
 * closed, reservations released. v3 CC-2: when the courts are closed (`byClub`) participants are CANCELLED_BY_CLUB.
 */
export async function cancelSocialSessionTx(tx: Tx, actor: Actor, sessionId: string, reason: string, opts: { byClub?: boolean } = {}) {
  const ss = await tx.socialSession.findUnique({ where: { id: sessionId }, include: { courts: true, participants: true } });
  if (!ss) throw new DomainError("NOT_FOUND", "Social session was not found.");
  if (ss.status !== "SCHEDULED") throw new DomainError("CANCEL_NOT_ALLOWED", "Only scheduled sessions can be cancelled.");
  const affected: Array<{ id: string; memberId: string | null; guestId: string | null; refunded: number; pending: number; refundRequestId: string | null }> = [];
  for (const p of ss.participants.filter((x) => x.status === "JOINED")) {
    let refunded = 0;
    let pending = 0;
    let refundRequestId: string | null = null;
    if (p.billId) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: p.billId } });
      refunded = netPaid(bill);
      // quiet: the cancellation message (notifySocialCancelled) says what happens to the money.
      if (refunded > 0) {
        const r = await refundTx(tx, actor, bill.id, refunded, { reason: `Social session cancelled by the club: ${reason}`, category: "CLUB_CANCELLATION", policy: opts.byClub ? "CC-2" : "SOCIAL_CANCELLED_BY_CLUB", quiet: true });
        pending = r.pending;
        refundRequestId = r.requestId;
      }
      await closeBill(tx, bill.id, "Social session cancelled by the club", clock.now());
    }
    await tx.socialParticipant.update({ where: { id: p.id }, data: { status: opts.byClub ? "CANCELLED_BY_CLUB" : "LEFT", leftAt: clock.now() } });
    affected.push({ id: p.id, memberId: p.memberId, guestId: p.guestId, refunded, pending, refundRequestId });
  }
  await tx.courtReservation.updateMany({ where: { id: { in: ss.courts.map((c) => c.reservationId) } }, data: { status: "CANCELLED" } });
  await tx.socialSession.update({ where: { id: ss.id }, data: { status: "CANCELLED" } });
  await audit(tx, actor, "social.cancel", "social_session", ss.id, { before: { status: ss.status }, after: { status: "CANCELLED", byClub: !!opts.byClub }, reason });
  return { sessionId: ss.id, title: ss.title, startAt: ss.startAt, endAt: ss.endAt, participants: affected };
}

export const joinSchema = z.object({
  sessionId: z.string().min(1),
  player: playerInputSchema,
  payment: paymentChoiceSchema.default({ kind: "LATER" }),
});

async function resolveOne(tx: Tx, p: PlayerInput) {
  if ("memberId" in p || "memberCode" in p || "memberPhone" in p) {
    const m = await findMemberRef(tx, p);
    if (!m) throw new DomainError("PLAYERS_INVALID", "Member was not found.");
    return { memberId: m.id, guestId: null, name: m.name };
  }
  if ("guestId" in p) {
    const g = await tx.guest.findUnique({ where: { id: p.guestId } });
    if (!g) throw new DomainError("PLAYERS_INVALID", "Guest was not found.");
    return { memberId: null, guestId: g.id, name: g.name };
  }
  const phone = p.guest.phone ? normalisePhone(p.guest.phone) : null;
  const g = await findOrCreateGuest(tx, { name: p.guest.name, phone, email: p.guest.email ?? null });
  return { memberId: null, guestId: g.id, name: g.name };
}

/** SP-3: capacity (session row locked) → daily limit → time conflict → booking window; fee = plan social_fee. */
export async function joinSessionTx(tx: Tx, actor: Actor, raw: z.input<typeof joinSchema>) {
  const input = joinSchema.parse(raw);
  const s = await getSettings(tx);
  const now = clock.now();
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM social_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
  if (!locked.length) throw new DomainError("NOT_FOUND", "Social session was not found.");
  const ss = await tx.socialSession.findUniqueOrThrow({ where: { id: input.sessionId }, include: { courts: true } });
  if (ss.status !== "SCHEDULED") throw new DomainError("SESSION_FULL", `“${ss.title}” is ${ss.status.toLowerCase()} and not taking players.`);
  const staff = can(actor, "bookings.any");
  if (!staff && !(actor.kind === "USER" && actor.role === "MEMBER")) throw new DomainError("FORBIDDEN", "Please log in as a member to join.");
  const grace = staff ? s.staff_grace_minutes * MINUTE : 0;
  if (ss.startAt.getTime() + grace <= now.getTime()) throw new DomainError("IN_PAST", `“${ss.title}” has already started.`);
  const player = await resolveOne(tx, input.player);
  if (!staff && player.memberId !== (actor.kind === "USER" ? actor.memberId : null)) {
    throw new DomainError("FORBIDDEN", "Not allowed: members can only join social play themselves.");
  }
  const capacity = ss.capacityPerCourt * ss.courts.length;
  const joined = await tx.socialParticipant.count({ where: { sessionId: ss.id, status: "JOINED" } });
  if (joined >= capacity) throw new DomainError("SESSION_FULL", `“${ss.title}” on ${fmtDate(istDate(ss.startAt))} is full (${capacity} players).`, { capacity });
  const date = istDate(ss.startAt);
  // Lock the player row (BK-3 applies to social joins too), then the shared rules.
  if (player.memberId) await tx.$queryRaw`SELECT id FROM members WHERE id = ${player.memberId} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM guests WHERE id = ${player.guestId} FOR UPDATE`;
  await assertDailyLimit(tx, [player], date, s);
  await assertNoTimeConflict(tx, [player], ss.startAt, ss.endAt);
  const ent = await entitlementsFor(tx, { memberId: player.memberId }, date, s);
  const lastDay = addDays(istDate(now), ent.advanceBookingDays);
  if (date > lastDay) {
    throw new DomainError("OUTSIDE_BOOKING_WINDOW", `${player.name} can join up to ${ent.advanceBookingDays} day(s) ahead — until ${fmtDate(lastDay)}.`);
  }
  const ref = player.memberId ? { memberId: player.memberId, name: player.name } : { guestId: player.guestId!, name: player.name };
  const q = await quoteSocial(tx, { date, title: ss.title, player: ref, startMinute: timeToMinutes(istTime(ss.startAt)) }, s);
  const channel = staff ? "FRONT_DESK" : "ONLINE_MEMBER";
  const participant = await tx.socialParticipant.create({
    data: { sessionId: ss.id, memberId: player.memberId, guestId: player.guestId, feeSnapshot: q.total, tierSnapshot: q.tier, channel, createdBy: actorId(actor) },
  });
  let bill = await createBill(tx, {
    sourceType: "SOCIAL_JOIN", sourceId: participant.id,
    customer: { memberId: player.memberId, guestId: player.guestId, name: player.name }, tier: q.tier, lines: q.lines, createdBy: actorId(actor),
  });
  await tx.socialParticipant.update({ where: { id: participant.id }, data: { billId: bill.id } });
  let payment: { redirectUrl: string; paymentId: string } | null = null;
  if (input.payment.kind === "COUNTER" && billDue(bill) > 0) {
    if (!staff) throw new DomainError("FORBIDDEN", "Counter payments are recorded by staff.");
    await recordPaymentTx(tx, actor, { ...input.payment, billId: bill.id, amount: billDue(bill) });
    bill = await tx.bill.findUniqueOrThrow({ where: { id: bill.id } });
  } else if (input.payment.kind === "ONLINE" && billDue(bill) > 0) {
    const p = await startOnlinePaymentTx(tx, actor, bill.id, { returnUrl: input.payment.returnUrl ?? "/portal/social", internal: true });
    payment = { redirectUrl: p.redirectUrl, paymentId: p.paymentId };
  }
  await audit(tx, actor, "social.join", "social_participant", participant.id, { after: { session: ss.title, player: player.name, fee: q.total } });
  if (player.memberId) {
    const m = await tx.member.findUnique({ where: { id: player.memberId }, select: { userId: true } });
    if (m?.userId) {
      await notify(tx, {
        userIds: [m.userId], type: "BOOKING_CONFIRMED", title: `Joined: ${ss.title}`,
        body: `${fmtDate(date)} ${fmtRange(ss.startAt, ss.endAt)} · fee ${formatINR(q.total)}`, link: "/portal/social",
        dedupeKey: `social-joined:${participant.id}`, email: true,
      });
    }
  }
  return {
    participantId: participant.id, sessionId: ss.id, name: player.name, tier: q.tier, fee: q.total,
    explanation: q.player.explanation, billId: bill.id, billStatus: bill.status, due: billDue(bill), payment,
  };
}

export async function joinSession(actor: Actor, raw: z.input<typeof joinSchema>, idempotencyKey?: string | null) {
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "social.join", body: raw }, () => joinSessionTx(tx, actor, raw)),
  );
}

/** Leaving follows the BK-7 refund rule. */
export async function leaveSession(actor: Actor, participantId: string, refundMethod?: "CASH" | "CARD" | "UPI", refundReference?: string) {
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const now = clock.now();
    const p = await tx.socialParticipant.findUnique({ where: { id: participantId }, include: { session: true } });
    if (!p) throw new DomainError("NOT_FOUND", "Participant was not found.");
    const own = actor.kind === "USER" && actor.role === "MEMBER" && p.memberId === actor.memberId;
    if (!own && !can(actor, "bookings.any")) throw new DomainError("FORBIDDEN", "Not allowed: you can only leave sessions you joined.");
    if (p.status !== "JOINED") throw new DomainError("CANCEL_NOT_ALLOWED", "This player already left.");
    if (p.session.startAt.getTime() <= now.getTime()) throw new DomainError("CANCEL_NOT_ALLOWED", "The session has already started.");
    const hoursBefore = (p.session.startAt.getTime() - now.getTime()) / HOUR;
    let refunded = 0;
    let refundPending = 0;
    if (p.billId && hoursBefore >= s.cancel_full_refund_hours) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: p.billId } });
      if (netPaid(bill) > 0) {
        const rr = await refundTx(tx, actor, bill.id, netPaid(bill), { method: refundMethod, reference: refundReference, approvalCode: refundReference, reason: `Left social play “${p.session.title}”`, category: "POLICY_CANCELLATION", policy: "SOCIAL_LEAVE_IN_TIME" });
        refunded = rr.refunded;
        refundPending = rr.pending;
      }
      await closeBill(tx, bill.id, "Left social play in time", now);
    }
    await tx.socialParticipant.update({ where: { id: p.id }, data: { status: "LEFT", leftAt: now } });
    await audit(tx, actor, "social.leave", "social_participant", p.id, { before: { status: "JOINED" }, after: { status: "LEFT", refunded, refundPending } });
    return { participantId: p.id, refunded, refundPending };
  });
}

export async function listSocialSessions(actor: Actor, opts: { from?: string; days?: number } = {}) {
  const from = opts.from && isValidDateStr(opts.from) ? opts.from : istDate(clock.now());
  const to = addDays(from, Math.min(opts.days ?? 28, 120));
  const sessions = await prisma.socialSession.findMany({
    where: { date: { gte: dbDate(from), lt: dbDate(to) } },
    include: { courts: true, participants: { where: { status: "JOINED" } } },
    orderBy: { startAt: "asc" },
  });
  const courts = await prisma.court.findMany();
  const staff = can(actor, "courts.view");
  const memberIds = sessions.flatMap((s) => s.participants.map((p) => p.memberId)).filter((x): x is string => !!x);
  const guestIds = sessions.flatMap((s) => s.participants.map((p) => p.guestId)).filter((x): x is string => !!x);
  const [members, guests] = staff
    ? await Promise.all([
        prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } }),
        prisma.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true } }),
      ])
    : [[], []];
  const myId = actor.kind === "USER" ? actor.memberId : null;
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    seriesId: s.seriesId,
    date: istDate(s.startAt),
    startAt: s.startAt,
    endAt: s.endAt,
    status: s.status,
    courts: s.courts.map((c) => courts.find((x) => x.id === c.courtId)?.name ?? "?"),
    capacity: s.capacityPerCourt * s.courts.length,
    joined: s.participants.length,
    myParticipantId: myId ? (s.participants.find((p) => p.memberId === myId)?.id ?? null) : null,
    participants: staff
      ? s.participants.map((p) => ({
          id: p.id,
          name: p.memberId ? (members.find((m) => m.id === p.memberId)?.name ?? "?") : (guests.find((g) => g.id === p.guestId)?.name ?? "?"),
          memberId: p.memberId, tier: p.tierSnapshot, fee: p.feeSnapshot, checkedInAt: p.checkedInAt, billId: p.billId,
        }))
      : [],
  }));
}
