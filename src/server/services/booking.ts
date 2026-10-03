// Booking engine (plan §5.4 CT-1…CT-4, §5.5 BK-1…BK-12; R-08…R-16; E-02, E-03, E-08).
// Validation order is BK-2: INVALID_SLOT → IN_PAST → COURT_INACTIVE → PLAYERS_INVALID → OUTSIDE_BOOKING_WINDOW →
// DAILY_LIMIT_REACHED → PLAYER_TIME_CONFLICT → SLOT_TAKEN (exclusion constraint) → price → bill → CONFIRMED.
import type { BookingChannel, Court, Prisma } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode, normalisePhone } from "@/lib/codes";
import { formatINR } from "@/lib/money";
import {
  addDays, fmtDate, fmtRange, HOUR, istDate, istDayRange, istTime, istToUtc, isValidDateStr, MINUTE, minutesToTime, timeToMinutes,
} from "@/lib/time";
import { nextSeq, pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { addBillLines, billDue, closeBill, createBill, netPaid, refreshBill, voidBillLines } from "./bills";
import { findOrCreateGuest } from "./guests";
import { idempotent } from "./idempotency";
import { notify } from "./notifications";
import { recordPaymentTx, refundTx, startOnlinePaymentTx } from "./payments";
import { entitlementsFor, priceLine, quoteCourt, type PlayerRef, type Tier } from "./pricing";
import { getSettings, type Settings } from "./settings";

export const SESSION_MINUTES = 60;
const STAFF_CHANNELS: BookingChannel[] = ["FRONT_DESK", "PHONE", "MESSAGE", "WALK_IN"];

// ───────────── inputs ─────────────

export const playerInputSchema = z.union([
  z.object({ memberId: z.string().min(1) }),
  z.object({ memberCode: z.string().min(3) }),
  // Completion pass §7 (member): add a partner by their mobile number as well as by member code.
  z.object({ memberPhone: z.string().min(10).max(20) }),
  z.object({ guestId: z.string().min(1) }),
  z.object({ guest: z.object({ name: z.string().trim().min(2).max(100), phone: z.string().optional(), email: z.string().email().optional() }) }),
]);
export type PlayerInput = z.infer<typeof playerInputSchema>;

export const paymentChoiceSchema = z.union([
  z.object({
    kind: z.literal("COUNTER"),
    method: z.enum(["CASH", "CARD", "UPI"]),
    reference: z.string().max(100).optional(),
    tendered: z.number().int().positive().optional(),
    cardLast4: z.string().max(4).optional(),
    approvalCode: z.string().max(20).optional(),
  }),
  z.object({ kind: z.literal("ONLINE"), returnUrl: z.string().max(300).optional() }),
  z.object({ kind: z.literal("LATER") }),
]);

export const createBookingSchema = z.object({
  courtId: z.string().min(1),
  date: z.string().refine(isValidDateStr, "date must be YYYY-MM-DD"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "start time must be HH:MM"),
  players: z.array(playerInputSchema).min(1, "add at least one player").max(20),
  /** Index in `players` of the primary (paying) player. Defaults to 0. */
  primaryIndex: z.number().int().min(0).default(0),
  channel: z.enum(["FRONT_DESK", "PHONE", "MESSAGE", "WALK_IN", "ONLINE_MEMBER", "ONLINE_TRIAL"]),
  payment: paymentChoiceSchema.default({ kind: "LATER" }),
  note: z.string().max(300).optional(),
});
export type CreateBookingInput = z.input<typeof createBookingSchema>;

type ResolvedPlayer = { memberId: string | null; guestId: string | null; name: string };

// ───────────── helpers ─────────────

function slotBounds(date: string, startTime: string) {
  const start = istToUtc(date, startTime);
  return { start, end: new Date(start.getTime() + SESSION_MINUTES * MINUTE) };
}

/** CT-3: start at :00 or :30, exactly 60 minutes, within opening hours. */
export function assertValidSlot(court: { name: string }, date: string, startTime: string, s: Settings) {
  const m = timeToMinutes(startTime);
  const open = timeToMinutes(s.opening_hours.open);
  const close = timeToMinutes(s.opening_hours.close);
  if (!/^\d{2}:(00|30)$/.test(startTime)) {
    throw new DomainError("INVALID_SLOT", `Sessions start on the hour or half hour (e.g. 18:00 or 18:30), not ${startTime}.`, { startTime });
  }
  if (m < open || m + SESSION_MINUTES > close) {
    throw new DomainError(
      "INVALID_SLOT",
      `${court.name} at ${startTime} would run ${startTime}–${minutesToTime(m + SESSION_MINUTES)}, outside opening hours ${s.opening_hours.open}–${s.opening_hours.close}.`,
      { startTime },
    );
  }
  void date;
}

/** A member given by id, member code or mobile number. */
export async function findMemberRef(db: Tx | typeof prisma, p: { memberId: string } | { memberCode: string } | { memberPhone: string }) {
  if ("memberId" in p) return db.member.findUnique({ where: { id: p.memberId } });
  if ("memberCode" in p) {
    const m = await db.member.findUnique({ where: { memberCode: p.memberCode.trim().toUpperCase() } });
    if (!m) throw new DomainError("PLAYERS_INVALID", `Member ${p.memberCode} was not found.`);
    return m;
  }
  const m = await db.member.findUnique({ where: { phone: normalisePhone(p.memberPhone) } });
  if (!m) throw new DomainError("PLAYERS_INVALID", `No member has the mobile number ${p.memberPhone}. Add them as a guest instead.`);
  return m;
}

async function resolvePlayers(tx: Tx, inputs: PlayerInput[]): Promise<ResolvedPlayer[]> {
  const out: ResolvedPlayer[] = [];
  for (const p of inputs) {
    if ("memberId" in p || "memberCode" in p || "memberPhone" in p) {
      const m = await findMemberRef(tx, p);
      if (!m) throw new DomainError("PLAYERS_INVALID", "Member was not found.");
      out.push({ memberId: m.id, guestId: null, name: m.name });
    } else if ("guestId" in p) {
      const g = await tx.guest.findUnique({ where: { id: p.guestId } });
      if (!g) throw new DomainError("PLAYERS_INVALID", "Guest was not found.");
      out.push({ memberId: null, guestId: g.id, name: g.name });
    } else {
      const phone = p.guest.phone ? normalisePhone(p.guest.phone) : null;
      const g = await findOrCreateGuest(tx, { name: p.guest.name, phone, email: p.guest.email ?? null });
      out.push({ memberId: null, guestId: g.id, name: g.name });
    }
  }
  return out;
}

/** BK-3: lock every player row (members, then guests, each ordered by id) before the limit/conflict checks. */
async function lockPlayers(tx: Tx, players: ResolvedPlayer[]) {
  const memberIds = [...new Set(players.map((p) => p.memberId).filter((x): x is string => !!x))].sort();
  const guestIds = [...new Set(players.map((p) => p.guestId).filter((x): x is string => !!x))].sort();
  if (memberIds.length) await tx.$queryRaw`SELECT id FROM members WHERE id = ANY(${memberIds}) ORDER BY id FOR UPDATE`;
  if (guestIds.length) await tx.$queryRaw`SELECT id FROM guests WHERE id = ANY(${guestIds}) ORDER BY id FOR UPDATE`;
}

type PlayRow = { ref: string; court: string; start_at: Date; end_at: Date; kind: string };

/** BK-4: plays (regular + social) of a member starting on an IST date, status ≠ CANCELLED. */
export async function playsOnDate(tx: Tx | typeof prisma, memberId: string, date: string, excludeBookingId?: string): Promise<PlayRow[]> {
  const [from, to] = istDayRange(date);
  return tx.$queryRaw<PlayRow[]>`
    SELECT b.booking_code AS ref, c.name AS court, r.start_at, r.end_at, 'BOOKING' AS kind
      FROM booking_players bp JOIN bookings b ON b.id = bp.booking_id
      JOIN court_reservations r ON r.id = b.reservation_id JOIN courts c ON c.id = r.court_id
     WHERE bp.member_id = ${memberId} AND bp.removed_at IS NULL AND b.status <> 'CANCELLED'
       AND r.start_at >= ${from} AND r.start_at < ${to} AND b.id <> ${excludeBookingId ?? ""}
    UNION ALL
    SELECT 'Social: ' || ss.title AS ref, 'social' AS court, ss.start_at, ss.end_at, 'SOCIAL' AS kind
      FROM social_participants sp JOIN social_sessions ss ON ss.id = sp.session_id
     WHERE sp.member_id = ${memberId} AND sp.status = 'JOINED' AND ss.status <> 'CANCELLED'
       AND ss.start_at >= ${from} AND ss.start_at < ${to}
     ORDER BY start_at`;
}

/** Sessions of a player (member or guest) overlapping [start, end). */
async function overlappingSessions(tx: Tx, p: ResolvedPlayer, start: Date, end: Date, excludeBookingId?: string): Promise<PlayRow[]> {
  const col = p.memberId ? "member" : "guest";
  const id = p.memberId ?? p.guestId!;
  return tx.$queryRaw<PlayRow[]>`
    SELECT b.booking_code AS ref, c.name AS court, r.start_at, r.end_at, 'BOOKING' AS kind
      FROM booking_players bp JOIN bookings b ON b.id = bp.booking_id
      JOIN court_reservations r ON r.id = b.reservation_id JOIN courts c ON c.id = r.court_id
     WHERE (CASE WHEN ${col} = 'member' THEN bp.member_id ELSE bp.guest_id END) = ${id}
       AND bp.removed_at IS NULL AND b.status <> 'CANCELLED' AND b.id <> ${excludeBookingId ?? ""}
       AND r.period && tstzrange(${start}, ${end}, '[)')
    UNION ALL
    SELECT 'Social: ' || ss.title AS ref, 'social' AS court, ss.start_at, ss.end_at, 'SOCIAL' AS kind
      FROM social_participants sp JOIN social_sessions ss ON ss.id = sp.session_id
     WHERE (CASE WHEN ${col} = 'member' THEN sp.member_id ELSE sp.guest_id END) = ${id}
       AND sp.status = 'JOINED' AND ss.status <> 'CANCELLED'
       AND tstzrange(ss.start_at, ss.end_at, '[)') && tstzrange(${start}, ${end}, '[)')`;
}

const describePlay = (r: PlayRow) => (r.kind === "SOCIAL" ? `${r.ref} ${fmtRange(r.start_at, r.end_at)}` : `${r.ref} (${r.court} ${fmtRange(r.start_at, r.end_at)})`);

/** BK-4 / BK-11: reject if any member player already has `max` plays that IST date, naming them. */
export async function assertDailyLimit(tx: Tx, players: ResolvedPlayer[], date: string, s: Settings, excludeBookingId?: string) {
  for (const p of players) {
    if (!p.memberId) continue; // guests are not limited (BK-4)
    const plays = await playsOnDate(tx, p.memberId, date, excludeBookingId);
    if (plays.length >= s.max_plays_per_day) {
      throw new DomainError(
        "DAILY_LIMIT_REACHED",
        `${p.name} already has ${plays.length} plays on ${fmtDate(date)}: ${plays.map(describePlay).join(", ")}. The limit is ${s.max_plays_per_day} per day.`,
        { player: p.name, existing: plays.map((x) => x.ref) },
      );
    }
  }
}

export async function assertNoTimeConflict(tx: Tx, players: ResolvedPlayer[], start: Date, end: Date, excludeBookingId?: string) {
  for (const p of players) {
    const clash = await overlappingSessions(tx, p, start, end, excludeBookingId);
    if (clash.length) {
      throw new DomainError(
        "PLAYER_TIME_CONFLICT",
        `${p.name} is already playing ${fmtRange(clash[0].start_at, clash[0].end_at)} in ${describePlay(clash[0])}.`,
        { player: p.name, existing: clash.map((x) => x.ref) },
      );
    }
  }
}

type ConflictRow = { kind: string; start_at: Date; end_at: Date; booking_code: string | null; title: string | null; note: string | null };

/** BK-11: describe whoever holds the court in [start, end). */
async function describeCourtConflict(tx: Tx, court: Court, start: Date, end: Date): Promise<{ message: string; codes: string[] }> {
  const rows = await tx.$queryRaw<ConflictRow[]>`
    SELECT r.kind::text AS kind, r.start_at, r.end_at, b.booking_code, ss.title, r.note
      FROM court_reservations r
      LEFT JOIN bookings b ON b.reservation_id = r.id
      LEFT JOIN social_session_courts sc ON sc.reservation_id = r.id
      LEFT JOIN social_sessions ss ON ss.id = sc.session_id
     WHERE r.court_id = ${court.id} AND r.status <> 'CANCELLED' AND r.period && tstzrange(${start}, ${end}, '[)')
     ORDER BY r.start_at`;
  if (!rows.length) return { message: `${court.name} is no longer free ${fmtRange(start, end)}.`, codes: [] };
  const parts = rows.map((r) =>
    r.kind === "REGULAR"
      ? `booked ${fmtRange(r.start_at, r.end_at)} (${r.booking_code})`
      : r.kind === "SOCIAL"
        ? `held for social play “${r.title}” ${fmtRange(r.start_at, r.end_at)}`
        : `blocked for maintenance ${fmtRange(r.start_at, r.end_at)}${r.note ? ` (${r.note})` : ""}`,
  );
  return { message: `${court.name} is already ${parts.join(" and ")}.`, codes: rows.map((r) => r.booking_code ?? r.title ?? "maintenance") };
}

/**
 * BK-1: insert the reservation and let the exclusion constraint decide. A savepoint lets us explain the conflict
 * (SQLSTATE 23P01 → SLOT_TAKEN) with the specific booking codes before the transaction rolls back.
 */
export async function insertReservation(
  tx: Tx,
  court: Court,
  start: Date,
  end: Date,
  kind: "REGULAR" | "SOCIAL" | "MAINTENANCE",
  createdBy: string | null,
  note?: string | null,
): Promise<string> {
  const id = `res_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  await tx.$executeRawUnsafe("SAVEPOINT reservation_insert");
  try {
    await tx.$executeRaw`
      INSERT INTO court_reservations (id, court_id, start_at, end_at, kind, status, note, created_by, updated_at)
      VALUES (${id}, ${court.id}, ${start}, ${end}, ${kind}::"ReservationKind", 'ACTIVE', ${note ?? null}, ${createdBy}, now())`;
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT reservation_insert");
    return id;
  } catch (e) {
    if (pgErrorCode(e) === "23P01") {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT reservation_insert");
      const c = await describeCourtConflict(tx, court, start, end);
      throw new DomainError("SLOT_TAKEN", c.message, { court: court.name, conflicts: c.codes });
    }
    throw e;
  }
}

function channelAllowed(actor: Actor, channel: BookingChannel, trial: boolean) {
  if (channel === "ONLINE_TRIAL") {
    if (trial) return;
    throw new DomainError("FORBIDDEN", "Trial bookings are made through the trial form.");
  }
  if (actor.kind === "SYSTEM") return;
  if (STAFF_CHANNELS.includes(channel)) {
    assertCan(actor, "bookings.any");
    return;
  }
  if (channel === "ONLINE_MEMBER") {
    if (actor.kind === "USER" && (actor.role === "MEMBER" || can(actor, "bookings.any"))) return;
    throw new DomainError("FORBIDDEN", "Please log in as a member to book online.");
  }
  throw new DomainError("FORBIDDEN", "This booking channel is not available.");
}

export type BookingResult = {
  bookingId: string;
  bookingCode: string;
  court: string;
  startAt: string;
  endAt: string;
  status: string;
  billId: string;
  total: number;
  billStatus: string;
  due: number;
  players: Array<{ name: string; tier: Tier; fee: number; explanation: string }>;
  payment: { redirectUrl: string; paymentId: string } | null;
};

/** The booking transaction body (shared by staff/member bookings, trial bookings and the seed). */
export async function createBookingTx(tx: Tx, actor: Actor, raw: CreateBookingInput, opts: { trial?: boolean } = {}): Promise<BookingResult> {
  const input = createBookingSchema.parse(raw);
  channelAllowed(actor, input.channel, !!opts.trial);
  const s = await getSettings(tx);
  const now = clock.now();
  const court = await tx.court.findUnique({ where: { id: input.courtId } });
  if (!court) throw new DomainError("NOT_FOUND", "Court was not found.");

  // 1. INVALID_SLOT
  assertValidSlot(court, input.date, input.startTime, s);
  const { start, end } = slotBounds(input.date, input.startTime);
  // 2. IN_PAST (staff channels get a grace period: a walk-in at 18:10 can take a free 18:00 slot)
  const grace = STAFF_CHANNELS.includes(input.channel) ? s.staff_grace_minutes * MINUTE : 0;
  if (start.getTime() + grace <= now.getTime()) {
    throw new DomainError("IN_PAST", `${court.name} ${fmtRange(start, end)} on ${fmtDate(input.date)} has already started or passed.`);
  }
  // 3. COURT_INACTIVE
  if (!court.active || court.archivedAt) throw new DomainError("COURT_INACTIVE", `${court.name} is not available for booking right now.`);
  // 4. PLAYERS_INVALID
  if (input.players.length > court.maxPlayers) {
    throw new DomainError("PLAYERS_INVALID", `${court.name} takes at most ${court.maxPlayers} players; ${input.players.length} were entered.`);
  }
  if (input.primaryIndex >= input.players.length) throw new DomainError("PLAYERS_INVALID", "The paying (primary) player must be one of the players.");
  const players = await resolvePlayers(tx, input.players);
  const keys = players.map((p) => p.memberId ?? `g:${p.guestId}`);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new DomainError("PLAYERS_INVALID", `${players[keys.indexOf(dup)].name} is listed twice.`);
  const primary = players[input.primaryIndex];
  if (actor.kind === "USER" && actor.role === "MEMBER" && primary.memberId !== actor.memberId) {
    throw new DomainError("FORBIDDEN", "Not allowed: online bookings must be made by the paying member themself.");
  }
  // 5. OUTSIDE_BOOKING_WINDOW (primary player's tier on the session date, E-08)
  const today = istDate(now);
  const ent = await entitlementsFor(tx, { memberId: primary.memberId }, input.date, s);
  const lastDay = addDays(today, ent.advanceBookingDays);
  if (input.date > lastDay) {
    throw new DomainError(
      "OUTSIDE_BOOKING_WINDOW",
      `${primary.name} (${ent.tier === "WALK_IN" ? "walk-in" : ent.tier}) can book up to ${ent.advanceBookingDays} day${ent.advanceBookingDays === 1 ? "" : "s"} ahead — until ${fmtDate(lastDay)}.`,
      { lastDay },
    );
  }
  // 6–7. lock players (BK-3), then DAILY_LIMIT_REACHED for every member player (BK-4), then PLAYER_TIME_CONFLICT
  await lockPlayers(tx, players);
  await assertDailyLimit(tx, players, input.date, s);
  await assertNoTimeConflict(tx, players, start, end);
  // 8. the court — decided by the exclusion constraint (BK-1)
  const reservationId = await insertReservation(tx, court, start, end, "REGULAR", actorId(actor));
  // 9. price (PR-4), bill, CONFIRMED
  const timeLabel = `${fmtDate(input.date)} ${fmtRange(start, end)}`;
  const refs: PlayerRef[] = players.map((p) => (p.memberId ? { memberId: p.memberId, name: p.name } : { guestId: p.guestId!, name: p.name }));
  const quote = await quoteCourt(tx, { sport: court.sport, date: input.date, courtName: court.name, timeLabel, players: refs }, s);
  if (opts.trial) {
    // CR-8: the trial fee is a setting (default ₹0), paid at the desk.
    quote.players = quote.players.map((p) => ({
      ...p,
      ...priceLine({ description: `Trial session: ${court.name} ${timeLabel} — ${p.name}`, qty: 1, unitPrice: s.trial_fee, taxCategory: "COURT", hsnSac: s.sac_codes.COURT, explanation: s.trial_fee ? `Trial session fee ${formatINR(s.trial_fee)}` : "Trial session · free" }, s),
    }));
    quote.total = quote.players.reduce((a, p) => a + p.netAmount, 0);
  }
  const code = formatCode("booking", await nextSeq(tx, CODE_SEQUENCE.booking));
  const booking = await tx.booking.create({
    data: {
      bookingCode: code, reservationId,
      primaryMemberId: primary.memberId, primaryGuestId: primary.memberId ? null : primary.guestId,
      channel: input.channel, status: "CONFIRMED", note: input.note ?? null, createdBy: actorId(actor),
    },
  });
  const bill = await createBill(tx, {
    sourceType: "BOOKING", sourceId: booking.id,
    customer: { memberId: primary.memberId, guestId: primary.memberId ? null : primary.guestId, name: primary.name },
    tier: quote.players[input.primaryIndex].tier, lines: [], createdBy: actorId(actor),
  });
  const lineIds = await addBillLines(tx, bill.id, quote.players);
  for (const [i, p] of quote.players.entries()) {
    await tx.bookingPlayer.create({
      data: { bookingId: booking.id, memberId: p.memberId, guestId: p.guestId, feeSnapshot: p.netAmount, tierSnapshot: p.tier, billLineId: lineIds[i] },
    });
  }
  let billNow = await refreshBill(tx, bill.id); // a ₹0 total is PAID automatically (BK-6)
  await tx.booking.update({ where: { id: booking.id }, data: { billId: bill.id } });
  await audit(tx, actor, "booking.create", "booking", booking.id, {
    after: { code, court: court.name, start, end, channel: input.channel, players: players.map((p) => p.name), total: quote.total },
  });

  let payment: BookingResult["payment"] = null;
  if (input.payment.kind === "COUNTER" && billDue(billNow) > 0) {
    if (!STAFF_CHANNELS.includes(input.channel) && !can(actor, "bookings.any")) {
      throw new DomainError("FORBIDDEN", "Counter payments are recorded by staff.");
    }
    await recordPaymentTx(tx, actor, { ...input.payment, billId: bill.id, amount: billDue(billNow) });
    billNow = await tx.bill.findUniqueOrThrow({ where: { id: bill.id } });
  } else if (input.payment.kind === "ONLINE" && billDue(billNow) > 0) {
    const p = await startOnlinePaymentTx(tx, actor, bill.id, { returnUrl: input.payment.returnUrl ?? "/portal/bookings", internal: true });
    payment = { redirectUrl: p.redirectUrl, paymentId: p.paymentId };
  }

  // E-16: notify member players
  const memberUsers = await tx.member.findMany({ where: { id: { in: players.map((p) => p.memberId).filter((x): x is string => !!x) } }, select: { userId: true } });
  await notify(tx, {
    userIds: memberUsers.map((m) => m.userId).filter((x): x is string => !!x),
    type: "BOOKING_CONFIRMED",
    title: `Booked: ${court.name} ${timeLabel}`,
    body: `${code} · players: ${players.map((p) => p.name).join(", ")} · total ${formatINR(quote.total)}${billDue(billNow) > 0 ? ` (${formatINR(billDue(billNow))} due)` : ""}`,
    link: "/portal/bookings",
    dedupeKey: `booking-confirmed:${booking.id}`,
    email: true,
  });

  return {
    bookingId: booking.id, bookingCode: code, court: court.name, startAt: start.toISOString(), endAt: end.toISOString(),
    status: "CONFIRMED", billId: bill.id, total: billNow.total, billStatus: billNow.status, due: billDue(billNow),
    players: quote.players.map((p) => ({ name: p.name, tier: p.tier, fee: p.netAmount, explanation: p.explanation })),
    payment,
  };
}

/** R-10: staff book for members, walk-ins, phone callers and message requests; members self-book online. */
export async function createBooking(actor: Actor, raw: CreateBookingInput, idempotencyKey?: string | null): Promise<BookingResult> {
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "bookings.create", body: raw }, () => createBookingTx(tx, actor, raw)),
  );
}

// ───────────── quote (PR-9) ─────────────

export async function quoteBooking(actor: Actor, raw: { courtId: string; date: string; startTime: string; players: PlayerInput[] }) {
  if (actor.kind === "PUBLIC") throw new DomainError("UNAUTHENTICATED", "Please log in.");
  const court = await prisma.court.findUnique({ where: { id: raw.courtId } });
  if (!court) throw new DomainError("NOT_FOUND", "Court was not found.");
  const refs: PlayerRef[] = [];
  for (const p of raw.players) {
    if ("memberId" in p) {
      const m = await prisma.member.findUnique({ where: { id: p.memberId } });
      if (m) refs.push({ memberId: m.id, name: m.name });
    } else if ("memberCode" in p || "memberPhone" in p) {
      const m = (await findMemberRef(prisma, p))!;
      refs.push({ memberId: m.id, name: m.name });
    } else if ("guestId" in p) {
      const g = await prisma.guest.findUnique({ where: { id: p.guestId } });
      if (g) refs.push({ guestId: g.id, name: g.name });
    } else {
      refs.push({ guestId: "new", name: p.guest.name });
    }
  }
  const { start, end } = slotBounds(raw.date, raw.startTime);
  const q = await quoteCourt(prisma, { sport: court.sport, date: raw.date, courtName: court.name, timeLabel: fmtRange(start, end), players: refs });
  return { total: q.total, taxTotal: q.taxTotal, players: q.players.map((p) => ({ name: p.name, tier: p.tier, fee: p.netAmount, explanation: p.explanation })) };
}

// ───────────── cancellation (BK-7) ─────────────

export const cancelBookingSchema = z.object({
  refundMethod: z.enum(["CASH", "CARD", "UPI"]).optional(),
  refundReference: z.string().trim().max(100).optional(),
  reason: z.string().max(300).optional(),
});

async function loadBookingForUpdate(tx: Tx, bookingId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
  if (!locked.length) throw new DomainError("NOT_FOUND", "Booking was not found.");
  return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { reservation: { include: { court: true } }, players: true } });
}

function assertStaffOrPrimary(actor: Actor, booking: { primaryMemberId: string | null }) {
  if (can(actor, "bookings.any")) return;
  if (actor.kind === "USER" && actor.role === "MEMBER" && booking.primaryMemberId && booking.primaryMemberId === actor.memberId) return;
  throw new DomainError("FORBIDDEN", "Not allowed: only the paying player or the front desk can change this booking.");
}

export async function cancelBookingTx(tx: Tx, actor: Actor, bookingId: string, raw: z.infer<typeof cancelBookingSchema> = {}) {
  const input = cancelBookingSchema.parse(raw);
  const s = await getSettings(tx);
  const now = clock.now();
  const b = await loadBookingForUpdate(tx, bookingId);
  assertStaffOrPrimary(actor, b);
  if (b.status !== "CONFIRMED") throw new DomainError("CANCEL_NOT_ALLOWED", `${b.bookingCode} is ${b.status.toLowerCase().replace("_", " ")} and can't be cancelled.`);
  if (b.reservation.startAt.getTime() <= now.getTime()) {
    throw new DomainError("CANCEL_NOT_ALLOWED", `${b.bookingCode} has already started (${fmtRange(b.reservation.startAt, b.reservation.endAt)}); it can no longer be cancelled.`);
  }
  const hoursBefore = (b.reservation.startAt.getTime() - now.getTime()) / HOUR;
  const fullRefund = hoursBefore >= s.cancel_full_refund_hours;
  let refunded = 0;
  let refundPending = 0;
  if (b.billId) {
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: b.billId } });
    if (fullRefund) {
      const paid = netPaid(bill);
      if (paid > 0) {
        const r = await refundTx(tx, actor, bill.id, paid, { method: input.refundMethod, reference: input.refundReference, approvalCode: input.refundReference, reason: `Booking ${b.bookingCode} cancelled ${hoursBefore.toFixed(1)}h before start` });
        refunded = r.refunded;
        refundPending = r.pending;
      }
      await closeBill(tx, bill.id, `Booking ${b.bookingCode} cancelled in time — nothing due`, now);
    }
    // Late cancellation: no refund, and any unpaid balance stays due (shown as member dues).
  }
  await tx.courtReservation.update({ where: { id: b.reservationId }, data: { status: "CANCELLED" } });
  await tx.booking.update({
    where: { id: b.id },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId(actor), cancelReason: input.reason ?? null },
  });
  await audit(tx, actor, "booking.cancel", "booking", b.id, {
    before: { status: "CONFIRMED" },
    after: { status: "CANCELLED", refunded, hoursBefore: Number(hoursBefore.toFixed(2)), fullRefund },
    reason: input.reason ?? null,
  });
  const memberUsers = await tx.member.findMany({ where: { id: { in: b.players.filter((p) => !p.removedAt).map((p) => p.memberId).filter((x): x is string => !!x) } }, select: { userId: true } });
  await notify(tx, {
    userIds: memberUsers.map((m) => m.userId).filter((x): x is string => !!x),
    type: "BOOKING_CANCELLED",
    title: `Cancelled: ${b.reservation.court.name} ${fmtDate(istDate(b.reservation.startAt))} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`,
    body: `${b.bookingCode} was cancelled. ${refunded ? `${formatINR(refunded)} refunded.` : ""}${refundPending ? ` ${formatINR(refundPending)} will be refunded at the front desk.` : ""}${!refunded && !refundPending ? (fullRefund ? "Nothing was charged." : `Cancelled less than ${s.cancel_full_refund_hours}h before start — no refund.`) : ""}`,
    link: "/portal/bookings",
    dedupeKey: `booking-cancelled:${b.id}`,
    email: true,
  });
  return { bookingId: b.id, bookingCode: b.bookingCode, status: "CANCELLED" as const, refunded, refundPending, fullRefund };
}

export async function cancelBooking(actor: Actor, bookingId: string, raw: z.infer<typeof cancelBookingSchema> = {}, outer?: Tx) {
  return withTx((tx) => cancelBookingTx(tx, actor, bookingId, raw), outer);
}

// ───────────── change players (BK-8) ─────────────

export const changePlayersSchema = z.object({
  players: z.array(playerInputSchema).min(1).max(20),
  refundMethod: z.enum(["CASH", "CARD", "UPI"]).optional(),
  refundReference: z.string().trim().max(100).optional(),
});

export async function changePlayers(actor: Actor, bookingId: string, raw: z.infer<typeof changePlayersSchema>) {
  const input = changePlayersSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const now = clock.now();
    const b = await loadBookingForUpdate(tx, bookingId);
    assertStaffOrPrimary(actor, b);
    if (b.status !== "CONFIRMED" || b.reservation.startAt.getTime() <= now.getTime()) {
      throw new DomainError("CANCEL_NOT_ALLOWED", `Players of ${b.bookingCode} can only be changed before it starts.`);
    }
    const court = b.reservation.court;
    const date = istDate(b.reservation.startAt);
    const wanted = await resolvePlayers(tx, input.players);
    const keys = wanted.map((p) => p.memberId ?? `g:${p.guestId}`);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new DomainError("PLAYERS_INVALID", `${wanted[keys.indexOf(dup)].name} is listed twice.`);
    if (wanted.length > court.maxPlayers) throw new DomainError("PLAYERS_INVALID", `${court.name} takes at most ${court.maxPlayers} players.`);
    const current = b.players.filter((p) => !p.removedAt);
    const curKeys = current.map((p) => p.memberId ?? `g:${p.guestId}`);
    const primaryKey = b.primaryMemberId ?? `g:${b.primaryGuestId}`;
    if (!keys.includes(primaryKey)) throw new DomainError("PLAYERS_INVALID", "The paying (primary) player must stay on the booking.");
    const added = wanted.filter((p, i) => !curKeys.includes(keys[i]));
    const removed = current.filter((p, i) => !keys.includes(curKeys[i]));
    if (!added.length && !removed.length) return { bookingId: b.id, added: 0, removed: 0, refunded: 0, due: 0 };
    // Steps 4–7 for the new players.
    await lockPlayers(tx, added);
    await assertDailyLimit(tx, added, date, s);
    await assertNoTimeConflict(tx, added, b.reservation.startAt, b.reservation.endAt);
    const hoursBefore = (b.reservation.startAt.getTime() - now.getTime()) / HOUR;
    const inTime = hoursBefore >= s.cancel_full_refund_hours;
    for (const r of removed) await tx.bookingPlayer.update({ where: { id: r.id }, data: { removedAt: now } });
    // BK-7 timing rule: removed players' fees come off the bill only when changed in time.
    if (inTime) await voidBillLines(tx, removed.map((r) => r.billLineId).filter((x): x is string => !!x), now);
    const refs: PlayerRef[] = added.map((p) => (p.memberId ? { memberId: p.memberId, name: p.name } : { guestId: p.guestId!, name: p.name }));
    let billId = b.billId!;
    if (refs.length) {
      const q = await quoteCourt(tx, { sport: court.sport, date, courtName: court.name, timeLabel: `${fmtDate(date)} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`, players: refs }, s);
      const ids = await addBillLines(tx, billId, q.players);
      for (const [i, p] of q.players.entries()) {
        await tx.bookingPlayer.create({ data: { bookingId: b.id, memberId: p.memberId, guestId: p.guestId, feeSnapshot: p.netAmount, tierSnapshot: p.tier, billLineId: ids[i] } });
      }
    }
    // Refund any overpayment created by removed players (only possible in time).
    const totals = await tx.$queryRaw<{ total: number }[]>`SELECT coalesce(sum(net_amount),0)::int AS total FROM bill_lines WHERE bill_id = ${billId} AND voided_at IS NULL`;
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
    const over = netPaid(bill) - totals[0].total;
    let refunded = 0;
    let refundPending = 0;
    if (over > 0) {
      const r = await refundTx(tx, actor, billId, over, { method: input.refundMethod, reference: input.refundReference, approvalCode: input.refundReference, reason: `Players changed on ${b.bookingCode}` });
      refunded = r.refunded;
      refundPending = r.pending;
    }
    const after = await refreshBill(tx, billId);
    billId = after.id;
    await audit(tx, actor, "booking.change_players", "booking", b.id, {
      before: { players: current.map((p) => p.memberId ?? p.guestId) },
      after: { added: added.map((p) => p.name), removed: removed.map((p) => p.memberId ?? p.guestId), refunded, refundPending, total: after.total },
    });
    const users = await tx.member.findMany({ where: { id: { in: added.map((p) => p.memberId).filter((x): x is string => !!x) } }, select: { userId: true } });
    await notify(tx, {
      userIds: users.map((u) => u.userId).filter((x): x is string => !!x),
      type: "BOOKING_PLAYER_ADDED",
      title: `You were added to ${b.bookingCode}`,
      body: `${court.name} ${fmtDate(date)} ${fmtRange(b.reservation.startAt, b.reservation.endAt)}`,
      link: "/portal/bookings",
      dedupeKey: `booking-player-added:${b.id}:${added.map((a) => a.memberId ?? a.guestId).join(",")}`,
      email: true,
    });
    return { bookingId: b.id, added: added.length, removed: removed.length, refunded, refundPending, due: billDue(after) };
  });
}

// ───────────── no-shows & completions (BK-9, BK-10) ─────────────

/** Job (every 5 minutes): ended sessions with no check-in → NO_SHOW; with at least one → COMPLETED. Idempotent. */
export async function markNoShowsAndCompletions(outer?: Tx) {
  return withTx(async (tx) => {
    const now = clock.now();
    const ended = await tx.booking.findMany({
      where: { status: "CONFIRMED", reservation: { endAt: { lte: now } } },
      include: { players: true },
    });
    let noShows = 0;
    let completed = 0;
    const actor = { kind: "SYSTEM" as const, name: "no-show-job" };
    for (const b of ended) {
      const any = b.players.some((p) => !p.removedAt && p.checkedInAt);
      await tx.booking.update({ where: { id: b.id }, data: { status: any ? "COMPLETED" : "NO_SHOW" } });
      await audit(tx, actor, any ? "booking.complete" : "booking.no_show", "booking", b.id, { before: { status: "CONFIRMED" }, after: { status: any ? "COMPLETED" : "NO_SHOW" } });
      if (any) completed++;
      else noShows++;
    }
    const socials = await tx.socialSession.updateMany({ where: { status: "SCHEDULED", endAt: { lte: now } }, data: { status: "COMPLETED" } });
    return { noShows, completed, socialCompleted: socials.count };
  }, outer);
}

// ───────────── maintenance (CT-4) ─────────────

export const maintenanceSchema = z.object({
  courtId: z.string().min(1),
  date: z.string().refine(isValidDateStr),
  startTime: z.string().regex(/^\d{2}:(00|30)$/, "start on :00 or :30"),
  endTime: z.string().regex(/^\d{2}:(00|30)$/, "end on :00 or :30"),
  note: z.string().trim().min(3).max(200),
});

export async function createMaintenance(actor: Actor, raw: z.infer<typeof maintenanceSchema>) {
  assertCan(actor, "maintenance.manage");
  const input = maintenanceSchema.parse(raw);
  return withTx(async (tx) => {
    const court = await tx.court.findUnique({ where: { id: input.courtId } });
    if (!court) throw new DomainError("NOT_FOUND", "Court was not found.");
    const start = istToUtc(input.date, input.startTime);
    const end = istToUtc(input.date, input.endTime);
    if (end <= start) throw new DomainError("INVALID_SLOT", "Maintenance must end after it starts.");
    const id = await insertReservation(tx, court, start, end, "MAINTENANCE", actorId(actor), input.note);
    await audit(tx, actor, "maintenance.create", "court_reservation", id, { after: { court: court.name, start, end, note: input.note } });
    return { reservationId: id };
  });
}

export async function cancelMaintenance(actor: Actor, reservationId: string) {
  assertCan(actor, "maintenance.manage");
  return withTx(async (tx) => {
    const r = await tx.courtReservation.findUnique({ where: { id: reservationId } });
    if (!r || r.kind !== "MAINTENANCE") throw new DomainError("NOT_FOUND", "Maintenance block was not found.");
    await tx.courtReservation.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
    await audit(tx, actor, "maintenance.cancel", "court_reservation", r.id, { before: { status: r.status }, after: { status: "CANCELLED" } });
    return { reservationId: r.id };
  });
}

// ───────────── availability (BK-12, R-09) ─────────────

export type Viewer = "STAFF" | "MEMBER" | "PUBLIC";

type ResRow = {
  id: string; court_id: string; start_at: Date; end_at: Date; kind: string; note: string | null;
  booking_id: string | null; booking_code: string | null; booking_status: string | null; primary_name: string | null; player_count: number | null;
  social_id: string | null; title: string | null; bill_due: number | null; checked_in: number | null;
};

export async function getAvailability(viewer: Viewer, from: string, days = 1) {
  if (!isValidDateStr(from)) throw new DomainError("VALIDATION_FAILED", "date must be YYYY-MM-DD");
  const n = Math.max(1, Math.min(days, 14));
  const s = await getSettings();
  const now = clock.now();
  const courts = await prisma.court.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const rangeStart = istToUtc(from, "00:00");
  const rangeEnd = istToUtc(addDays(from, n), "00:00");
  const rows = await prisma.$queryRaw<ResRow[]>`
    SELECT r.id, r.court_id, r.start_at, r.end_at, r.kind::text AS kind, r.note,
           b.id AS booking_id, b.booking_code, b.status::text AS booking_status,
           coalesce(m.name, g.name) AS primary_name,
           (SELECT count(*)::int FROM booking_players bp WHERE bp.booking_id = b.id AND bp.removed_at IS NULL) AS player_count,
           (SELECT count(*)::int FROM booking_players bp WHERE bp.booking_id = b.id AND bp.removed_at IS NULL AND bp.checked_in_at IS NOT NULL) AS checked_in,
           ss.id AS social_id, ss.title,
           CASE WHEN bl.closed_at IS NULL THEN greatest(0, bl.total - (bl.amount_paid - bl.amount_refunded)) ELSE 0 END AS bill_due
      FROM court_reservations r
      LEFT JOIN bookings b ON b.reservation_id = r.id
      LEFT JOIN members m ON m.id = b.primary_member_id
      LEFT JOIN guests g ON g.id = b.primary_guest_id
      LEFT JOIN bills bl ON bl.id = b.bill_id
      LEFT JOIN social_session_courts sc ON sc.reservation_id = r.id
      LEFT JOIN social_sessions ss ON ss.id = sc.session_id
     WHERE r.status <> 'CANCELLED' AND r.period && tstzrange(${rangeStart}, ${rangeEnd}, '[)')`;
  const open = timeToMinutes(s.opening_hours.open);
  const close = timeToMinutes(s.opening_hours.close);
  const out = [];
  for (let d = 0; d < n; d++) {
    const date = addDays(from, d);
    const dayCourts = courts.map((c) => {
      const res = rows.filter((r) => r.court_id === c.id);
      const label = (r: ResRow) => {
        if (r.kind === "SOCIAL") return viewer === "STAFF" ? `Social: ${r.title}` : "Social";
        if (r.kind === "MAINTENANCE") return viewer === "STAFF" ? `Maintenance${r.note ? `: ${r.note}` : ""}` : "Maintenance";
        if (viewer !== "STAFF") return "Booked";
        return `${r.primary_name}${(r.player_count ?? 1) > 1 ? ` +${(r.player_count ?? 1) - 1}` : ""}`;
      };
      const slots = [];
      for (let m = open; m + 30 <= close; m += 30) {
        const t = minutesToTime(m);
        const cellStart = istToUtc(date, t);
        const cellEnd = new Date(cellStart.getTime() + 30 * MINUTE);
        const sessionEnd = new Date(cellStart.getTime() + SESSION_MINUTES * MINUTE);
        const occ = res.find((r) => r.start_at < cellEnd && r.end_at > cellStart);
        const blocking = res.find((r) => r.start_at < sessionEnd && r.end_at > cellStart);
        const startable = m + SESSION_MINUTES <= close;
        const past = cellStart.getTime() <= now.getTime();
        slots.push({
          time: t,
          state: occ ? (occ.kind === "REGULAR" ? "BOOKED" : occ.kind) : "FREE",
          label: occ ? label(occ) : "Free",
          bookable: c.active && startable && !past && !blocking,
          past,
          ...(viewer === "STAFF" && occ
            ? {
                reservationId: occ.id,
                bookingId: occ.booking_id,
                bookingCode: occ.booking_code,
                socialId: occ.social_id,
                isStart: occ.start_at.getTime() === cellStart.getTime(),
                unpaid: (occ.bill_due ?? 0) > 0,
                checkedIn: (occ.checked_in ?? 0) > 0,
                range: fmtRange(occ.start_at, occ.end_at),
              }
            : {}),
        });
      }
      return { courtId: c.id, name: c.name, sport: c.sport, maxPlayers: c.maxPlayers, active: c.active, slots };
    });
    out.push({ date, courts: dayCourts });
  }
  return { from, days: n, open: s.opening_hours.open, close: s.opening_hours.close, now: now.toISOString(), today: istDate(now), viewer, dates: out };
}

// ───────────── read side ─────────────

export async function listBookings(actor: Actor, q: { date?: string; status?: string; courtId?: string; search?: string }) {
  assertCan(actor, "courts.view");
  const date = q.date && isValidDateStr(q.date) ? q.date : istDate(clock.now());
  const [from, to] = istDayRange(date);
  const where: Prisma.BookingWhereInput = {
    reservation: { startAt: { gte: from, lt: to }, courtId: q.courtId || undefined },
    status: q.status ? (q.status as Prisma.EnumBookingStatusFilter["equals"]) : undefined,
  };
  const rows = await prisma.booking.findMany({
    where,
    include: { reservation: { include: { court: true } }, players: true },
    orderBy: { reservation: { startAt: "asc" } },
  });
  return decorateBookings(rows, q.search);
}

async function decorateBookings(
  rows: Array<Prisma.BookingGetPayload<{ include: { reservation: { include: { court: true } }; players: true } }>>,
  search?: string,
) {
  const memberIds = rows.flatMap((b) => b.players.map((p) => p.memberId)).filter((x): x is string => !!x);
  const guestIds = rows.flatMap((b) => b.players.map((p) => p.guestId)).filter((x): x is string => !!x);
  const [members, guests, bills] = await Promise.all([
    prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, memberCode: true } }),
    prisma.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true } }),
    prisma.bill.findMany({ where: { id: { in: rows.map((b) => b.billId).filter((x): x is string => !!x) } } }),
  ]);
  const name = (p: { memberId: string | null; guestId: string | null }) =>
    p.memberId ? (members.find((m) => m.id === p.memberId)?.name ?? "?") : (guests.find((g) => g.id === p.guestId)?.name ?? "?");
  const out = rows.map((b) => {
    const bill = bills.find((x) => x.id === b.billId);
    return {
      id: b.id,
      code: b.bookingCode,
      court: b.reservation.court.name,
      courtId: b.reservation.courtId,
      startAt: b.reservation.startAt,
      endAt: b.reservation.endAt,
      status: b.status,
      channel: b.channel,
      primaryMemberId: b.primaryMemberId,
      players: b.players.filter((p) => !p.removedAt).map((p) => ({ id: p.id, memberId: p.memberId, guestId: p.guestId, name: name(p), fee: p.feeSnapshot, tier: p.tierSnapshot, checkedInAt: p.checkedInAt })),
      billId: b.billId,
      total: bill?.total ?? 0,
      due: bill ? billDue(bill) : 0,
      billStatus: bill?.status ?? "UNPAID",
      cancelledAt: b.cancelledAt,
    };
  });
  const term = search?.trim().toLowerCase();
  return term ? out.filter((b) => b.code.toLowerCase().includes(term) || b.players.some((p) => p.name.toLowerCase().includes(term))) : out;
}

export async function getBooking(actor: Actor, bookingId: string) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { reservation: { include: { court: true } }, players: true } });
  if (!b) throw new DomainError("NOT_FOUND", "Booking was not found.");
  if (!can(actor, "courts.view")) {
    const mine = actor.kind === "USER" && actor.role === "MEMBER" && b.players.some((p) => p.memberId === actor.memberId);
    if (!mine) throw new DomainError("FORBIDDEN", "Not allowed: this booking belongs to someone else.");
  }
  return (await decorateBookings([b]))[0];
}

export async function myBookings(actor: Actor) {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Members only.");
  const rows = await prisma.booking.findMany({
    where: { players: { some: { memberId: actor.memberId, removedAt: null } } },
    include: { reservation: { include: { court: true } }, players: true },
    orderBy: { reservation: { startAt: "desc" } },
    take: 200,
  });
  return decorateBookings(rows);
}

export function slotLabel(start: Date, end: Date) {
  return `${fmtDate(istDate(start))} ${istTime(start)}–${istTime(end)}`;
}
