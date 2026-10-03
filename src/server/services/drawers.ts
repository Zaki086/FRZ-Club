// Cash drawers — v4 §2 "Cash Drawer v2" (builds on completion pass 8.4 and v3 §5.1).
// - A till (`cash_drawers`) holds at most one OPEN session, and a staff member has at most one OPEN session.
// - Every cash movement of a session is an append-only `drawer_movements` row with the running balance, so the cash
//   expected in the drawer is always Σ movements (CD-1). Cash payments and refunds write their movement in the same
//   transaction as the payment and the ledger entry (payments.ts calls the *Tx helpers below; CD-2, RF-9).
// - Card/UPI/online money is linked to the session for the "collected by other methods" panel, never to the cash.
// - Close: blind count by denomination (CD-5); a variance over the tolerance waits for Manager/Owner approval
//   (CD-6); the counted cash is split into the float carried in the till and the drop to the safe (CD-7); a shift
//   handover is a close followed by an open of the same till (CD-8).
// - The safe: cash drops in, pay-ins and bank deposits out (§2.6).
import { Prisma, type CashDrawer, type CashDrawerSession, type DrawerMovement } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { dbDate, fromDbDate, istDate, istDayRange, isValidDateStr } from "@/lib/time";
import { prisma, pgErrorCode, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import type { ApprovalItem } from "./approvals";
import { audit } from "./audit";
import { notify } from "./notifications";
import { getSettings } from "./settings";

type Db = Tx | typeof prisma;

export const DRAWER_AREAS = ["DESK", "SHOP", "BAR", "OFFICE"] as const;
export type DrawerArea = (typeof DRAWER_AREAS)[number];
export const TILL_LOCATIONS = ["FRONT_DESK", "SHOP", "BAR", "OFFICE"] as const;
export type TillLocation = (typeof TILL_LOCATIONS)[number];
export const LOCATION_LABEL: Record<TillLocation, string> = { FRONT_DESK: "Front desk", SHOP: "Shop", BAR: "Bar", OFFICE: "Office" };
const AREA_OF: Record<TillLocation, DrawerArea> = { FRONT_DESK: "DESK", SHOP: "SHOP", BAR: "BAR", OFFICE: "OFFICE" };
const LOCATION_OF: Record<DrawerArea, TillLocation> = { DESK: "FRONT_DESK", SHOP: "SHOP", BAR: "BAR", OFFICE: "OFFICE" };
const TILL_BASE_NAME: Record<TillLocation, string> = { FRONT_DESK: "Front Desk Till", SHOP: "Shop Till", BAR: "Bar Till", OFFICE: "Office Till" };

export const MOVEMENT_TYPES = ["OPENING_FLOAT", "CASH_SALE", "CASH_REFUND", "PAY_IN", "PAY_OUT", "CASH_DROP", "CLOSING_ADJUSTMENT"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const SESSION_STATUSES = ["OPEN", "PENDING_APPROVAL", "CLOSED", "APPROVED", "REJECTED"] as const;
export const PAY_OUT_CATEGORIES = ["STOCK_PURCHASE", "UTILITIES", "MAINTENANCE", "MARKETING", "OTHER"] as const;

function userOf(actor: Actor): string {
  if (actor.kind !== "USER") throw new DomainError("FORBIDDEN", "Only staff members have cash drawers.");
  return actor.userId;
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

// ───────────── denominations (§2.3) ─────────────

export const denominationCountsSchema = z
  .array(z.object({ kind: z.enum(["NOTE", "COIN"]), value: z.number().int().positive(), count: z.number().int().min(0).max(100_000) }))
  .max(30);
export type DenominationCounts = z.infer<typeof denominationCountsSchema>;

/** Validate a count against the denominations in Settings and return its total (paise). */
async function countTotal(db: Db, counts: DenominationCounts): Promise<{ total: number; counts: DenominationCounts }> {
  const s = await getSettings(db as Tx);
  const seen = new Set<string>();
  for (const c of counts) {
    const allowed = c.kind === "NOTE" ? s.cash_denominations.notes : s.cash_denominations.coins;
    const label = `${formatINR(c.value)} ${c.kind === "NOTE" ? "notes" : "coins"}`;
    if (!allowed.includes(c.value)) throw new DomainError("VALIDATION_FAILED", `${label} are not a denomination in Settings.`);
    const k = `${c.kind}:${c.value}`;
    if (seen.has(k)) throw new DomainError("VALIDATION_FAILED", `${label} are counted twice.`);
    seen.add(k);
  }
  const kept = counts.filter((c) => c.count > 0);
  return { total: kept.reduce((a, c) => a + c.value * c.count, 0), counts: kept };
}

// ───────────── sessions and movements (CD-1) ─────────────

/** The open drawer session of a staff member, if any. */
export async function currentDrawer(db: Db, actor: Actor) {
  if (actor.kind !== "USER") return null;
  return db.cashDrawerSession.findFirst({ where: { userId: actor.userId, closedAt: null } });
}

/** Counter payments and refunds by staff need an open drawer (8.4, CD-2). Jobs and the gateway don't. */
export async function requireDrawer(tx: Tx, actor: Actor): Promise<string | null> {
  if (actor.kind !== "USER") return null;
  const d = await currentDrawer(tx, actor);
  if (!d) {
    throw new DomainError("DRAWER_NOT_OPEN", "Open your cash drawer (count the starting float) before taking or returning payments.", { userId: actor.userId });
  }
  return d.id;
}

/** Lock a session row for a movement; only an open session takes movements (except at its own close). */
async function lockSession(tx: Tx, sessionId: string, opts: { mustBeOpen?: boolean } = {}) {
  const rows = await tx.$queryRaw<{ id: string; closed_at: Date | null }[]>`SELECT id, closed_at FROM cash_drawer_sessions WHERE id = ${sessionId} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
  if (opts.mustBeOpen !== false && rows[0].closed_at) throw new DomainError("DRAWER_NOT_OPEN", "This cash drawer is already closed.");
}

/** CD-1: the cash expected in a session right now (paise) = Σ its movements (the last running balance). */
export async function drawerBalanceTx(tx: Db, sessionId: string): Promise<number> {
  const last = await tx.drawerMovement.findFirst({ where: { sessionId }, orderBy: { lineNo: "desc" }, select: { balanceAfter: true } });
  return last?.balanceAfter ?? 0;
}

type MoveInput = {
  sessionId: string; type: MovementType; amount: number; actor: Actor; atClose?: boolean;
  paymentId?: string | null; expenseId?: string | null; reference?: string | null; category?: string | null; note?: string | null;
};

/** Append one movement with its running balance. The caller holds the session lock (lockSession). */
async function appendMovement(tx: Tx, m: MoveInput): Promise<DrawerMovement> {
  const last = await tx.drawerMovement.findFirst({ where: { sessionId: m.sessionId }, orderBy: { lineNo: "desc" }, select: { lineNo: true, balanceAfter: true } });
  return tx.drawerMovement.create({
    data: {
      sessionId: m.sessionId, lineNo: (last?.lineNo ?? 0) + 1, type: m.type, amount: m.amount, balanceAfter: (last?.balanceAfter ?? 0) + m.amount,
      atClose: !!m.atClose, paymentId: m.paymentId ?? null, expenseId: m.expenseId ?? null, reference: m.reference ?? null,
      category: m.category ?? null, actorId: actorId(m.actor), note: m.note ?? null, at: clock.now(),
    },
  });
}

/**
 * CD-4: before a cash sale with change, the change must already be in the drawer (the customer's own notes are not
 * change). Blocks with INSUFFICIENT_CHANGE and suggests a pay-in. Locks the session for the sale's movement.
 */
export async function assertChangeAvailableTx(tx: Tx, sessionId: string, change: number): Promise<void> {
  await lockSession(tx, sessionId);
  if (change <= 0) return;
  const balance = await drawerBalanceTx(tx, sessionId);
  if (change > balance) {
    throw new DomainError(
      "INSUFFICIENT_CHANGE",
      `Change of ${formatINR(change)} is more than the ${formatINR(balance)} in your drawer. Add change with a Pay in (from the safe), or ask for a smaller note.`,
      { change, balance },
    );
  }
}

/** CD-1/CD-2: the CASH_SALE movement of a cash payment (same transaction as the payment and its ledger entry). */
export async function writeCashSaleTx(tx: Tx, actor: Actor, sessionId: string, paymentId: string, amount: number) {
  await lockSession(tx, sessionId);
  return appendMovement(tx, { sessionId, type: "CASH_SALE", amount, paymentId, actor });
}

/** The cash in a session right now, with the session locked (for a refund decision). */
export async function cashAvailableTx(tx: Tx, sessionId: string): Promise<number> {
  await lockSession(tx, sessionId);
  return drawerBalanceTx(tx, sessionId);
}

/** RF-9: the CASH_REFUND movement of a cash refund paid out now; INSUFFICIENT_CASH_IN_DRAWER when it can't be covered. */
export async function writeCashRefundTx(tx: Tx, actor: Actor, sessionId: string, paymentId: string, amount: number) {
  const balance = await cashAvailableTx(tx, sessionId);
  if (amount > balance) throw insufficientCash(balance, amount, "pay out");
  return appendMovement(tx, { sessionId, type: "CASH_REFUND", amount: -amount, paymentId, actor });
}

export function insufficientCash(balance: number, amount: number, what: string) {
  return new DomainError(
    "INSUFFICIENT_CASH_IN_DRAWER",
    `Your drawer holds ${formatINR(balance)} — not enough to ${what} ${formatINR(amount)} in cash. Add cash with a Pay in (from the safe) first.`,
    { balance, amount },
  );
}

// ───────────── the safe (§2.6) ─────────────

const SAFE_LOCK_KEY = 7_340_014_002;

/** Safe balance = Σ cash drops − Σ pay-ins from the safe − Σ bank deposits. */
export async function safeBalanceTx(db: Db): Promise<number> {
  const last = await db.safeMovement.findFirst({ orderBy: { lineNo: "desc" }, select: { balanceAfter: true } });
  return last?.balanceAfter ?? 0;
}

async function appendSafe(tx: Tx, m: { type: "CASH_DROP" | "PAY_IN" | "BANK_DEPOSIT"; amount: number; actor: Actor; drawerMovementId?: string; bankDepositId?: string; reference?: string | null; note?: string | null }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAFE_LOCK_KEY}::bigint)`;
  const last = await tx.safeMovement.findFirst({ orderBy: { lineNo: "desc" }, select: { lineNo: true, balanceAfter: true } });
  const balance = last?.balanceAfter ?? 0;
  if (balance + m.amount < 0) {
    throw new DomainError("VALIDATION_FAILED", `The safe holds ${formatINR(balance)} (cash drops minus pay-ins and bank deposits) — not enough for ${formatINR(-m.amount)}.`, { safe: balance, amount: -m.amount });
  }
  return tx.safeMovement.create({
    data: {
      lineNo: (last?.lineNo ?? 0) + 1, type: m.type, amount: m.amount, balanceAfter: balance + m.amount,
      drawerMovementId: m.drawerMovementId ?? null, bankDepositId: m.bankDepositId ?? null, reference: m.reference ?? null,
      actorId: actorId(m.actor), note: m.note ?? null, at: clock.now(),
    },
  });
}

// ───────────── tills (Owner, Settings) ─────────────

const tillName = z.string().trim().min(2, "Give the till a name (2–60 characters).").max(60);
export const tillSchema = z.object({
  name: tillName,
  location: z.enum(TILL_LOCATIONS),
  defaultFloat: z.number().int().min(0).max(10_000_000).default(0),
});
export const tillUpdateSchema = z.object({
  name: tillName.optional(),
  location: z.enum(TILL_LOCATIONS).optional(),
  defaultFloat: z.number().int().min(0).max(10_000_000).optional(),
  active: z.boolean().optional(),
});

async function createTillTx(tx: Tx, actor: Actor, input: z.infer<typeof tillSchema>) {
  const dup = await tx.cashDrawer.findFirst({ where: { name: { equals: input.name, mode: "insensitive" } } });
  if (dup) throw new DomainError("VALIDATION_FAILED", `A till called “${input.name}” already exists.`);
  const t = await tx.cashDrawer.create({ data: { name: input.name, location: input.location, defaultFloat: input.defaultFloat, createdBy: actorId(actor) } });
  await audit(tx, actor, "till.create", "cash_drawer", t.id, { after: { name: t.name, location: t.location, defaultFloat: t.defaultFloat } });
  return t;
}

/** §2.1: the Owner adds the real tills (name, location, default float). */
export async function createTill(actor: Actor, raw: z.input<typeof tillSchema>, outer?: Tx) {
  assertCan(actor, "settings");
  const input = tillSchema.parse(raw);
  return withTx((tx) => createTillTx(tx, actor, input), outer);
}

export async function updateTill(actor: Actor, id: string, raw: z.input<typeof tillUpdateSchema>) {
  assertCan(actor, "settings");
  const input = tillUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await tx.cashDrawer.findUnique({ where: { id } });
    if (!before) throw new DomainError("NOT_FOUND", "Till was not found.");
    const open = await tx.cashDrawerSession.findFirst({ where: { drawerId: id, closedAt: null } });
    if (open && (input.active === false || (input.location && input.location !== before.location))) {
      throw new DomainError("VALIDATION_FAILED", `${before.name} is open right now. Close it before moving or retiring it.`);
    }
    if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const dup = await tx.cashDrawer.findFirst({ where: { name: { equals: input.name, mode: "insensitive" }, id: { not: id } } });
      if (dup) throw new DomainError("VALIDATION_FAILED", `A till called “${input.name}” already exists.`);
    }
    const t = await tx.cashDrawer.update({ where: { id }, data: input });
    await audit(tx, actor, "till.update", "cash_drawer", id, { before: { name: before.name, location: before.location, defaultFloat: before.defaultFloat, active: before.active }, after: input });
    return t;
  });
}

async function lastClosedOf(db: Db, drawerId: string) {
  return db.cashDrawerSession.findFirst({ where: { drawerId, closedAt: { not: null } }, orderBy: { closedAt: "desc" } });
}

/** The tills (for the open dialog / Settings) with who has them open, the live balance and what the last close left. */
export async function listTills(actor: Actor, opts: { includeInactive?: boolean } = {}) {
  assertCan(actor, "staff.self");
  const all = !!opts.includeInactive && can(actor, "settings");
  const tills = await prisma.cashDrawer.findMany({ where: all ? {} : { active: true }, orderBy: [{ location: "asc" }, { name: "asc" }] });
  const open = await prisma.cashDrawerSession.findMany({ where: { closedAt: null, drawerId: { in: tills.map((t) => t.id) } } });
  const users = await prisma.user.findMany({ where: { id: { in: open.map((s) => s.userId) } }, select: { id: true, name: true } });
  const out = [];
  for (const t of tills) {
    const s = open.find((x) => x.drawerId === t.id);
    const last = await lastClosedOf(prisma, t.id);
    out.push({
      id: t.id, name: t.name, location: t.location as TillLocation, defaultFloat: t.defaultFloat, active: t.active,
      openSession: s
        ? { id: s.id, userName: users.find((u) => u.id === s.userId)?.name ?? "?", openedAt: s.openedAt, mine: actor.kind === "USER" && s.userId === actor.userId }
        : null,
      lastClose: last ? { at: last.closedAt, floatCarried: last.floatCarried } : null,
    });
  }
  return out;
}

/** Legacy `area` callers: a free active till at that location, or the next numbered till there (a new physical till). */
async function tillForArea(tx: Tx, actor: Actor, area: DrawerArea): Promise<CashDrawer> {
  const location = LOCATION_OF[area];
  const tills = await tx.cashDrawer.findMany({ where: { location, active: true }, orderBy: [{ createdAt: "asc" }, { name: "asc" }] });
  for (const t of tills) {
    if (!(await tx.cashDrawerSession.findFirst({ where: { drawerId: t.id, closedAt: null }, select: { id: true } }))) return t;
  }
  const count = await tx.cashDrawer.count({ where: { location } });
  for (let n = count + 1; n < count + 50; n++) {
    const name = location === "FRONT_DESK" || n > 1 ? `${TILL_BASE_NAME[location]} ${n}` : TILL_BASE_NAME[location];
    if (await tx.cashDrawer.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } })) continue;
    return createTillTx(tx, actor, { name, location, defaultFloat: 0 });
  }
  throw new DomainError("VALIDATION_FAILED", "No free till at this location.");
}

// ───────────── open (§2.3) ─────────────

export const openDrawerSchema = z.object({
  /** The till to open (the open dialog). */
  drawerId: z.string().min(1).optional(),
  /** Legacy callers: the location; a free till there is used. */
  area: z.enum(DRAWER_AREAS).optional(),
  /** The float as a total (legacy) — or counted by denomination below (then both must agree). */
  openingFloat: z.number().int().min(0).max(10_000_000).optional(),
  counts: denominationCountsSchema.optional(),
});

export async function openDrawer(actor: Actor, raw: z.input<typeof openDrawerSchema>, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = openDrawerSchema.parse(raw);
  const userId = userOf(actor);
  if (!input.drawerId && !input.area) throw new DomainError("VALIDATION_FAILED", "Choose the till you are opening.");
  if (input.openingFloat === undefined && !input.counts) throw new DomainError("VALIDATION_FAILED", "Count the starting float.");
  return withTx(async (tx) => {
    let float = input.openingFloat ?? 0;
    let counts: DenominationCounts | null = null;
    if (input.counts) {
      const c = await countTotal(tx, input.counts);
      if (input.openingFloat !== undefined && input.openingFloat !== c.total) {
        throw new DomainError("VALIDATION_FAILED", `The counted notes and coins add up to ${formatINR(c.total)}, not ${formatINR(input.openingFloat)}.`);
      }
      float = c.total;
      counts = c.counts;
    }
    if (await currentDrawer(tx, actor)) throw new DomainError("VALIDATION_FAILED", "Your cash drawer is already open. Close it before opening a new one.");
    let till: CashDrawer | null;
    if (input.drawerId) {
      till = await tx.cashDrawer.findUnique({ where: { id: input.drawerId } });
      if (!till) throw new DomainError("NOT_FOUND", "Till was not found.");
      if (!till.active) throw new DomainError("VALIDATION_FAILED", `${till.name} is not in use any more.`);
    } else {
      till = await tillForArea(tx, actor, input.area!);
    }
    await tx.$queryRaw`SELECT id FROM cash_drawers WHERE id = ${till.id} FOR UPDATE`;
    const busy = await tx.cashDrawerSession.findFirst({ where: { drawerId: till.id, closedAt: null } });
    if (busy) {
      const who = await tx.user.findUnique({ where: { id: busy.userId }, select: { name: true } });
      throw new DomainError("DRAWER_IN_USE", `${till.name} is open by ${who?.name ?? "someone else"}. Two people never share a drawer — they close it first (handover), or you open another till.`, { drawerId: till.id });
    }
    const last = await lastClosedOf(tx, till.id);
    let d: CashDrawerSession;
    try {
      d = await tx.cashDrawerSession.create({
        data: { userId, drawerId: till.id, area: AREA_OF[till.location as TillLocation], openingFloat: float, openingCounts: (counts ?? undefined) as Prisma.InputJsonValue | undefined, openedAt: clock.now(), status: "OPEN" },
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("DRAWER_IN_USE", `${till.name} or your own drawer is already open.`);
      throw e;
    }
    const carried = last?.floatCarried ?? null;
    await appendMovement(tx, {
      sessionId: d.id, type: "OPENING_FLOAT", amount: float, actor,
      note: carried !== null && carried !== float ? `Counted ${formatINR(float)}; ${formatINR(carried)} was left in the till at the last close` : "Opening float",
    });
    await audit(tx, actor, "drawer.open", "cash_drawer_session", d.id, { after: { drawer: till.name, area: d.area, openingFloat: float, counts, carriedIn: carried } });
    if (carried !== null && carried !== float) {
      await notify(tx, {
        roles: ["MANAGER", "OWNER"], type: "CASH_VARIANCE", title: `Float differs at handover: ${till.name}`,
        body: `${actor.kind === "USER" ? actor.name : "Staff"} counted ${formatINR(float)} when opening ${till.name}; ${formatINR(carried)} was left in it at the last close.`,
        link: `/app/finance/drawers/${d.id}`, dedupeKey: `drawer-handover:${d.id}`,
      });
    }
    return d;
  }, outer);
}

// ───────────── totals by method (v3 §5.1) ─────────────

export const COLLECTION_METHODS = ["CASH", "UPI", "CARD", "ONLINE"] as const;

/** What a session collected by method (count + amount). Cash is in the drawer; the rest went to the bank/terminal. */
async function drawerTotals(db: Db, sessionId: string) {
  const rows = await db.payment.groupBy({
    by: ["method", "type"],
    where: { drawerSessionId: sessionId, status: "SUCCEEDED" },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const sum = (method: string, type: string) => rows.find((r) => r.method === method && r.type === type)?._sum.amount ?? 0;
  const n = (method: string, type: string) => rows.find((r) => r.method === method && r.type === type)?._count._all ?? 0;
  const collections = COLLECTION_METHODS.map((m) => ({ method: m, count: n(m, "PAYMENT"), amount: sum(m, "PAYMENT"), refundCount: n(m, "REFUND"), refunded: sum(m, "REFUND") }));
  return {
    collections,
    totalCollected: collections.reduce((a, c) => a + c.amount, 0),
    totalRefunded: collections.reduce((a, c) => a + c.refunded, 0),
    online: sum("ONLINE", "PAYMENT") - sum("ONLINE", "REFUND"),
    cashIn: sum("CASH", "PAYMENT"),
    cashOut: sum("CASH", "REFUND"),
    card: sum("CARD", "PAYMENT") - sum("CARD", "REFUND"),
    upi: sum("UPI", "PAYMENT") - sum("UPI", "REFUND"),
  };
}

/** §2.4 summary strip: opening float · cash sales · cash refunds · pay-ins · pay-outs · drops (count + ₹ each). */
async function movementSummary(db: Db, sessionId: string) {
  const rows = await db.drawerMovement.groupBy({ by: ["type", "atClose"], where: { sessionId }, _sum: { amount: true }, _count: { _all: true } });
  const pick = (type: MovementType, atClose?: boolean) => {
    const r = rows.filter((x) => x.type === type && (atClose === undefined || x.atClose === atClose));
    return { count: r.reduce((a, x) => a + x._count._all, 0), amount: Math.abs(r.reduce((a, x) => a + (x._sum.amount ?? 0), 0)) };
  };
  return {
    openingFloat: pick("OPENING_FLOAT").amount,
    sales: pick("CASH_SALE"), refunds: pick("CASH_REFUND"), payIns: pick("PAY_IN"), payOuts: pick("PAY_OUT"),
    drops: pick("CASH_DROP", false), closingDrop: pick("CASH_DROP", true).amount,
    adjustment: rows.filter((x) => x.type === "CLOSING_ADJUSTMENT").reduce((a, x) => a + (x._sum.amount ?? 0), 0),
  };
}

async function tillOf(db: Db, drawerId: string | null) {
  return drawerId ? db.cashDrawer.findUnique({ where: { id: drawerId } }) : null;
}

function sessionName(s: { area: string }, till: CashDrawer | null) {
  return till?.name ?? `${titleCase(s.area)} drawer`;
}

/** The caller's drawer with the live balance, the §2.4 summary and the totals by method (the "My Cash Drawer" screen). */
export async function myDrawer(actor: Actor) {
  assertCan(actor, "staff.self");
  const s = await getSettings();
  const rules = { blindClose: s.blind_close, tolerance: s.drawer_variance_tolerance, denominations: s.cash_denominations };
  const d = await currentDrawer(prisma, actor);
  const lastClosed = actor.kind === "USER" && !d
    ? await prisma.cashDrawerSession.findFirst({ where: { userId: actor.userId, closedAt: { not: null } }, orderBy: { closedAt: "desc" } })
    : null;
  const last = lastClosed
    ? {
        id: lastClosed.id, status: lastClosed.status, closedAt: lastClosed.closedAt, cashExpected: lastClosed.cashExpected, cashCounted: lastClosed.cashCounted,
        variance: lastClosed.variance, varianceReason: lastClosed.varianceReason, floatCarried: lastClosed.floatCarried, cashDropped: lastClosed.cashDropped,
        rejectionReason: lastClosed.rejectionReason, name: sessionName(lastClosed, await tillOf(prisma, lastClosed.drawerId)),
      }
    : null;
  if (!d) return { open: null, last, rules };
  const till = await tillOf(prisma, d.drawerId);
  const balance = await drawerBalanceTx(prisma, d.id);
  return {
    open: {
      ...d, ...(await drawerTotals(prisma, d.id)),
      name: sessionName(d, till), defaultFloat: till?.defaultFloat ?? 0,
      cashExpected: balance, balance, summary: await movementSummary(prisma, d.id),
    },
    last,
    rules,
  };
}

/** CD-1: the signed-in staff member's open drawer and its cash right now (the header badge polls this). */
export async function myDrawerBalance(actor: Actor): Promise<{ open: null | { sessionId: string; name: string; balancePaise: number } }> {
  if (actor.kind !== "USER" || actor.role === "MEMBER") return { open: null };
  const d = await currentDrawer(prisma, actor);
  if (!d) return { open: null };
  return { open: { sessionId: d.id, name: sessionName(d, await tillOf(prisma, d.drawerId)), balancePaise: await drawerBalanceTx(prisma, d.id) } };
}

// ───────────── pay in / pay out / cash drop (§2.1) ─────────────

const reasonText = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(200);
export const payInSchema = z.object({ amount: z.number().int().positive().max(10_000_000), reason: reasonText });
export const payOutSchema = z.object({
  amount: z.number().int().positive().max(10_000_000),
  reason: reasonText,
  category: z.enum(PAY_OUT_CATEGORIES),
  paidTo: z.string().trim().min(2).max(120).optional(),
});
export const cashDropSchema = z.object({
  amount: z.number().int().positive().max(100_000_000),
  bagRef: z.string().trim().min(2, "Enter the sealed bag's number.").max(60),
  note: z.string().trim().max(200).optional(),
});

async function ownOpenSession(tx: Tx, actor: Actor) {
  const id = await requireDrawer(tx, actor);
  if (!id) throw new DomainError("FORBIDDEN", "Only staff members have cash drawers.");
  await lockSession(tx, id);
  return tx.cashDrawerSession.findUniqueOrThrow({ where: { id } });
}

/** PAY_IN: change brought from the safe into the open drawer (reason required). */
export async function payIn(actor: Actor, raw: z.input<typeof payInSchema>) {
  assertCan(actor, "staff.self");
  const input = payInSchema.parse(raw);
  return withTx(async (tx) => {
    const d = await ownOpenSession(tx, actor);
    const m = await appendMovement(tx, { sessionId: d.id, type: "PAY_IN", amount: input.amount, actor, note: input.reason });
    await appendSafe(tx, { type: "PAY_IN", amount: -input.amount, actor, drawerMovementId: m.id, note: input.reason });
    await audit(tx, actor, "drawer.pay_in", "cash_drawer_session", d.id, { after: { amount: input.amount, reason: input.reason, balance: m.balanceAfter } });
    return { movementId: m.id, balance: m.balanceAfter };
  });
}

/** PAY_OUT: petty cash spent from the drawer — creates an expense bill marked PAID by cash (reason + category). */
export async function payOut(actor: Actor, raw: z.input<typeof payOutSchema>) {
  assertCan(actor, "staff.self");
  const input = payOutSchema.parse(raw);
  return withTx(async (tx) => {
    const d = await ownOpenSession(tx, actor);
    const balance = await drawerBalanceTx(tx, d.id);
    if (input.amount > balance) throw insufficientCash(balance, input.amount, "pay out");
    const { createExpenseTx, payExpenseTx } = await import("./expenses");
    const name = sessionName(d, await tillOf(tx, d.drawerId));
    const e = await createExpenseTx(tx, actor, {
      vendor: input.paidTo ?? "Petty cash", category: input.category, description: `Petty cash from ${name}: ${input.reason}`,
      amount: input.amount, inputGst: 0, dueInDays: 0, refType: "cash_drawer_session", refId: d.id,
    });
    await payExpenseTx(tx, actor, e.id, { method: "CASH", reference: name });
    const m = await appendMovement(tx, { sessionId: d.id, type: "PAY_OUT", amount: -input.amount, actor, expenseId: e.id, category: input.category, note: input.reason, reference: input.paidTo ?? null });
    await audit(tx, actor, "drawer.pay_out", "cash_drawer_session", d.id, { after: { amount: input.amount, reason: input.reason, category: input.category, expenseId: e.id, balance: m.balanceAfter } });
    return { movementId: m.id, expenseId: e.id, balance: m.balanceAfter };
  });
}

/** CASH_DROP: excess cash moved from the drawer to the safe in a sealed bag (bag reference required). */
export async function cashDrop(actor: Actor, raw: z.input<typeof cashDropSchema>) {
  assertCan(actor, "staff.self");
  const input = cashDropSchema.parse(raw);
  return withTx(async (tx) => {
    const d = await ownOpenSession(tx, actor);
    const balance = await drawerBalanceTx(tx, d.id);
    if (input.amount > balance) throw insufficientCash(balance, input.amount, "drop");
    const m = await appendMovement(tx, { sessionId: d.id, type: "CASH_DROP", amount: -input.amount, actor, reference: input.bagRef, note: input.note ?? null });
    await appendSafe(tx, { type: "CASH_DROP", amount: input.amount, actor, drawerMovementId: m.id, reference: input.bagRef, note: input.note ?? null });
    await audit(tx, actor, "drawer.cash_drop", "cash_drawer_session", d.id, { after: { amount: input.amount, bagRef: input.bagRef, balance: m.balanceAfter } });
    return { movementId: m.id, balance: m.balanceAfter };
  });
}

// ───────────── close (CD-5 … CD-8) ─────────────

export const closeDrawerSchema = z.object({
  /** Total counted (legacy) — or the blind count by denomination below (then both must agree). */
  cashCounted: z.number().int().min(0).optional(),
  counts: denominationCountsSchema.optional(),
  /** CD-7: cash left in the till for the next session; the rest of the count is dropped to the safe. Default 0. */
  floatCarried: z.number().int().min(0).optional(),
  /** Sealed bag of the closing drop. */
  bagRef: z.string().trim().max(60).optional(),
  /** CD-6: why the count differs (can also be given right after the close, see explainDrawerVariance). */
  varianceReason: z.string().trim().max(300).optional(),
  note: z.string().max(300).optional(),
});

/**
 * Close the actor's drawer. Expected = Σ movements; variance = counted − expected, recorded as a CLOSING_ADJUSTMENT.
 * |variance| ≤ tolerance → CLOSED; above it → PENDING_APPROVAL until a Manager/Owner approves (CD-6). The counted
 * cash is then split: the float carried (stays in the till) and the drop to the safe (CASH_DROP + safe row, CD-7).
 * A shift handover (CD-8) is this close followed by the next person's openDrawer on the same till.
 */
export async function closeDrawer(actor: Actor, raw: z.input<typeof closeDrawerSchema>, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = closeDrawerSchema.parse(raw);
  const userId = userOf(actor);
  if (input.cashCounted === undefined && !input.counts) throw new DomainError("VALIDATION_FAILED", "Count the cash in the drawer.");
  return withTx(async (tx) => {
    const open = await tx.cashDrawerSession.findFirst({ where: { userId, closedAt: null } });
    if (!open) throw new DomainError("DRAWER_NOT_OPEN", "You have no open cash drawer.");
    await lockSession(tx, open.id);
    const s = await getSettings(tx);
    let counted = input.cashCounted ?? 0;
    let counts: DenominationCounts | null = null;
    if (input.counts) {
      const c = await countTotal(tx, input.counts);
      if (input.cashCounted !== undefined && input.cashCounted !== c.total) {
        throw new DomainError("VALIDATION_FAILED", `The counted notes and coins add up to ${formatINR(c.total)}, not ${formatINR(input.cashCounted)}.`);
      }
      counted = c.total;
      counts = c.counts;
    }
    if ((input.floatCarried ?? 0) > counted) throw new DomainError("VALIDATION_FAILED", `You can't leave ${formatINR(input.floatCarried!)} in the till: you counted ${formatINR(counted)}.`);
    const carried = input.floatCarried ?? 0;
    const dropped = counted - carried;
    const expected = await drawerBalanceTx(tx, open.id);
    const variance = counted - expected;
    const needsApproval = Math.abs(variance) > s.drawer_variance_tolerance;
    const t = await drawerTotals(tx, open.id);
    const name = sessionName(open, await tillOf(tx, open.drawerId));
    if (variance !== 0) {
      await appendMovement(tx, { sessionId: open.id, type: "CLOSING_ADJUSTMENT", amount: variance, actor, atClose: true, note: input.varianceReason || (variance > 0 ? "Over at close" : "Short at close") });
    }
    if (dropped > 0) {
      const m = await appendMovement(tx, { sessionId: open.id, type: "CASH_DROP", amount: -dropped, actor, atClose: true, reference: input.bagRef || null, note: "Closing drop to the safe" });
      await appendSafe(tx, { type: "CASH_DROP", amount: dropped, actor, drawerMovementId: m.id, reference: input.bagRef || null, note: `Closing drop · ${name}` });
    }
    const closed = await tx.cashDrawerSession.update({
      where: { id: open.id },
      data: {
        closedAt: clock.now(), closedBy: userId, cashExpected: expected, cashCounted: counted, variance, cardTotal: t.card, upiTotal: t.upi,
        note: input.note ?? null, status: needsApproval ? "PENDING_APPROVAL" : "CLOSED",
        closingCounts: (counts ?? undefined) as Prisma.InputJsonValue | undefined, floatCarried: carried, cashDropped: dropped, dropRef: input.bagRef || null,
        varianceReason: input.varianceReason || null,
      },
    });
    await audit(tx, actor, "drawer.close", "cash_drawer_session", open.id, {
      after: { drawer: name, cashExpected: expected, cashCounted: counted, variance, status: closed.status, floatCarried: carried, cashDropped: dropped, counts },
      reason: input.varianceReason ?? null,
    });
    const who = actor.kind === "USER" ? actor.name : "Staff";
    if (variance !== 0) {
      await notify(tx, {
        roles: ["MANAGER", "OWNER", "ACCOUNTANT"], type: "CASH_VARIANCE", title: `Cash variance ${formatINR(variance)}`,
        body: `${who} closed ${name}: expected ${formatINR(expected)}, counted ${formatINR(counted)}.`,
        link: `/app/finance/drawers/${open.id}`, dedupeKey: `cash-variance:${open.id}`,
      });
    }
    if (needsApproval) {
      await notify(tx, {
        roles: ["MANAGER", "OWNER"], type: "DRAWER_VARIANCE", title: `Drawer variance needs approval: ${formatINR(variance)}`,
        body: `${who} closed ${name} ${variance < 0 ? "short" : "over"} by ${formatINR(Math.abs(variance))} (tolerance ${formatINR(s.drawer_variance_tolerance)}).`,
        link: `/app/finance/drawers/${open.id}`, dedupeKey: `drawer-variance-approval:${open.id}`,
      });
    }
    return { ...closed, name, needsApproval, needsReason: needsApproval && !closed.varianceReason, tolerance: s.drawer_variance_tolerance };
  }, outer);
}

// ───────────── variance approval (CD-6, RN-4) ─────────────

export const varianceReasonSchema = z.object({ reason: z.string().trim().min(3, "Explain the difference (at least 3 characters).").max(300) });

/** The staff member explains a variance that waits for approval (right after a blind close). */
export async function explainDrawerVariance(actor: Actor, sessionId: string, reason: string) {
  assertCan(actor, "staff.self");
  const r = varianceReasonSchema.parse({ reason }).reason;
  return withTx(async (tx) => {
    await lockSession(tx, sessionId, { mustBeOpen: false });
    const d = await tx.cashDrawerSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (actor.kind !== "USER" || d.userId !== actor.userId) throw new DomainError("FORBIDDEN", "Not allowed: only the person who closed this drawer explains its variance.");
    if (d.status !== "PENDING_APPROVAL") throw new DomainError("VALIDATION_FAILED", "This drawer is not waiting for approval.");
    const u = await tx.cashDrawerSession.update({ where: { id: d.id }, data: { varianceReason: r } });
    await audit(tx, actor, "drawer.variance_reason", "cash_drawer_session", d.id, { before: { varianceReason: d.varianceReason }, after: { varianceReason: r } });
    return u;
  });
}

async function decideVariance(actor: Actor, sessionId: string, decision: "APPROVED" | "REJECTED", reason?: string) {
  assertCan(actor, "cash.approve_variance");
  return withTx(async (tx) => {
    await lockSession(tx, sessionId, { mustBeOpen: false });
    const d = await tx.cashDrawerSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (d.status !== "PENDING_APPROVAL") throw new DomainError("VALIDATION_FAILED", `This drawer's variance is not waiting for approval (it is ${d.status.replace("_", " ").toLowerCase()}).`);
    if (actor.kind === "USER" && actor.userId === d.userId) throw new DomainError("FORBIDDEN", "Not allowed: you can't approve the variance of your own drawer.");
    const now = clock.now();
    const u = await tx.cashDrawerSession.update({
      where: { id: d.id },
      data: decision === "APPROVED" ? { status: "APPROVED", approvedBy: actorId(actor), approvedAt: now } : { status: "REJECTED", rejectedBy: actorId(actor), rejectedAt: now, rejectionReason: reason ?? null },
    });
    await audit(tx, actor, decision === "APPROVED" ? "drawer.variance_approve" : "drawer.variance_reject", "cash_drawer_session", d.id, {
      before: { status: d.status }, after: { status: decision, variance: d.variance }, reason: reason ?? null,
    });
    const name = sessionName(d, await tillOf(tx, d.drawerId));
    await notify(tx, {
      userIds: [d.userId], type: "DRAWER_VARIANCE", title: `Drawer variance ${decision === "APPROVED" ? "approved" : "not accepted"}: ${formatINR(d.variance ?? 0)}`,
      body: decision === "APPROVED" ? `The ${formatINR(d.variance ?? 0)} variance on ${name} was approved.` : `The ${formatINR(d.variance ?? 0)} variance on ${name} was not accepted: ${reason}.`,
      link: "/app/drawer", dedupeKey: `drawer-variance-decision:${d.id}`,
    });
    return u;
  });
}

async function assertSessionExists(sessionId: string) {
  if (!(await prisma.cashDrawerSession.findUnique({ where: { id: sessionId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
}

/** CD-6: approve a drawer session's variance (PENDING_APPROVAL → APPROVED). Manager or Owner, never their own drawer. */
export async function approveDrawerVariance(actor: Actor, sessionId: string) {
  assertCan(actor, "cash.approve_variance");
  await assertSessionExists(sessionId);
  return decideVariance(actor, sessionId, "APPROVED");
}

/** CD-6: reject a drawer session's variance explanation (PENDING_APPROVAL → REJECTED, reason required). */
export async function rejectDrawerVariance(actor: Actor, sessionId: string, reason: string) {
  assertCan(actor, "cash.approve_variance");
  const r = z.string().trim().min(3, "Give a reason for rejecting (at least 3 characters).").max(300).parse(reason ?? "");
  await assertSessionExists(sessionId);
  return decideVariance(actor, sessionId, "REJECTED", r);
}

/** RN-4: drawer sessions closed with a variance over the tolerance that wait for this Manager/Owner. */
export async function listDrawerVarianceApprovals(actor: Actor): Promise<ApprovalItem[]> {
  if (!can(actor, "cash.approve_variance")) return [];
  const rows = await prisma.cashDrawerSession.findMany({
    where: { status: "PENDING_APPROVAL", ...(actor.kind === "USER" ? { userId: { not: actor.userId } } : {}) },
    orderBy: { closedAt: "asc" },
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } });
  const tills = await prisma.cashDrawer.findMany({ where: { id: { in: rows.map((r) => r.drawerId ?? "") } } });
  return rows.map((r) => {
    const name = sessionName(r, tills.find((t) => t.id === r.drawerId) ?? null);
    const v = r.variance ?? 0;
    return {
      kind: "DRAWER_VARIANCE" as const,
      id: r.id,
      title: `${name}: ${v < 0 ? "short" : "over"} by ${formatINR(Math.abs(v))}`,
      detail: `Expected ${formatINR(r.cashExpected ?? 0)}, counted ${formatINR(r.cashCounted ?? 0)}. ${r.varianceReason ? `Reason: ${r.varianceReason}` : "No reason given yet."}`,
      amountPaise: v,
      requestedBy: users.find((u) => u.id === r.userId)?.name ?? "?",
      requestedAt: (r.closedAt ?? r.openedAt).toISOString(),
      href: `/app/finance/drawers/${r.id}`,
    };
  });
}

// ───────────── read side ─────────────

/** What each movement points at: the bill (customer, source), the refund request, or the expense. */
async function movementLinks(movements: Array<{ id: string; paymentId: string | null }>) {
  const pays = await prisma.payment.findMany({
    where: { id: { in: movements.map((m) => m.paymentId).filter((x): x is string => !!x) } },
    include: { bill: { select: { customerName: true, sourceType: true } } },
  });
  const requests = await prisma.refundRequest.findMany({ where: { id: { in: pays.map((p) => p.refundRequestId).filter((x): x is string => !!x) } }, select: { id: true, code: true } });
  const out = new Map<string, { billId: string | null; customer: string | null; source: string | null; refundCode: string | null }>();
  for (const m of movements) {
    const p = pays.find((x) => x.id === m.paymentId);
    out.set(m.id, { billId: p?.billId ?? null, customer: p?.bill.customerName ?? null, source: p?.bill.sourceType ?? null, refundCode: requests.find((r) => r.id === p?.refundRequestId)?.code ?? null });
  }
  return out;
}

/** One session with its movements (the session's owner, or Owner/Manager/Accountant). */
export async function getDrawerSession(actor: Actor, sessionId: string) {
  const d = await prisma.cashDrawerSession.findUnique({ where: { id: sessionId } });
  if (!d) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
  const own = actor.kind === "USER" && actor.userId === d.userId;
  if (!own && !can(actor, "cash.reconcile") && !can(actor, "dashboard.ops")) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this drawer.");
  const till = await tillOf(prisma, d.drawerId);
  const movements = await prisma.drawerMovement.findMany({ where: { sessionId }, orderBy: { lineNo: "asc" } });
  const ids = [d.userId, d.approvedBy, d.rejectedBy, ...movements.map((m) => m.actorId)].filter((x): x is string => !!x);
  const people = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  const links = await movementLinks(movements);
  return {
    ...d,
    name: sessionName(d, till), location: till?.location ?? LOCATION_OF[d.area as DrawerArea] ?? null, staff: nameOf(d.userId),
    approvedByName: nameOf(d.approvedBy), rejectedByName: nameOf(d.rejectedBy),
    balance: await drawerBalanceTx(prisma, sessionId),
    summary: await movementSummary(prisma, sessionId),
    ...(await drawerTotals(prisma, sessionId)),
    movements: movements.map((m) => ({ ...m, actor: nameOf(m.actorId), ...links.get(m.id) })),
    canDecide: d.status === "PENDING_APPROVAL" && can(actor, "cash.approve_variance") && !own,
    canExplain: d.status === "PENDING_APPROVAL" && own,
  };
}

/**
 * v3 §5.1 drill-down: the payments (and refunds) behind one method's total in a session. They add up exactly to the
 * total on the drawer screen. The session's owner, and Owner/Manager/Accountant, may look.
 */
export async function drawerPayments(actor: Actor, sessionId: string, method: string) {
  const d = await prisma.cashDrawerSession.findUnique({ where: { id: sessionId } });
  if (!d) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
  const own = actor.kind === "USER" && actor.userId === d.userId;
  if (!own && !can(actor, "cash.reconcile") && !can(actor, "dashboard.ops")) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see this drawer.");
  if (!(COLLECTION_METHODS as readonly string[]).includes(method)) throw new DomainError("VALIDATION_FAILED", "Unknown payment method.");
  const rows = await prisma.payment.findMany({
    where: { drawerSessionId: sessionId, status: "SUCCEEDED", method: method as (typeof COLLECTION_METHODS)[number] },
    include: { bill: { select: { customerName: true, sourceType: true } } },
    orderBy: { occurredAt: "asc" },
  });
  const list = rows.map((p) => ({ id: p.id, type: p.type, amount: p.amount, reference: p.reference ?? p.approvalCode, at: p.occurredAt, customer: p.bill.customerName, source: p.bill.sourceType, billId: p.billId }));
  return {
    method,
    payments: list.filter((p) => p.type === "PAYMENT"),
    refunds: list.filter((p) => p.type === "REFUND"),
    total: list.filter((p) => p.type === "PAYMENT").reduce((a, p) => a + p.amount, 0),
    refunded: list.filter((p) => p.type === "REFUND").reduce((a, p) => a + p.amount, 0),
  };
}

/** Owner "Cash Drawers": every till with its live balance, the safe, approvals waiting and the latest deposits. */
export async function drawersOverview(actor: Actor) {
  if (!can(actor, "cash.reconcile") && !can(actor, "dashboard.ops")) throw new DomainError("FORBIDDEN", "Not allowed: you cannot see the cash drawers.");
  const tills = await prisma.cashDrawer.findMany({ orderBy: [{ active: "desc" }, { location: "asc" }, { name: "asc" }] });
  const open = await prisma.cashDrawerSession.findMany({ where: { closedAt: null } });
  const users = await prisma.user.findMany({ where: { id: { in: open.map((s) => s.userId) } }, select: { id: true, name: true } });
  const staffName = (id: string) => users.find((u) => u.id === id)?.name ?? "?";
  const rows = [];
  for (const t of tills) {
    const s = open.find((x) => x.drawerId === t.id);
    const last = await lastClosedOf(prisma, t.id);
    rows.push({
      id: t.id, name: t.name, location: t.location, active: t.active, defaultFloat: t.defaultFloat,
      open: s ? { sessionId: s.id, staff: staffName(s.userId), since: s.openedAt, balance: await drawerBalanceTx(prisma, s.id) } : null,
      lastClose: last ? { sessionId: last.id, at: last.closedAt, floatCarried: last.floatCarried, status: last.status, variance: last.variance } : null,
    });
  }
  // Sessions opened without a till (rows written outside the services) still count as open drawers.
  for (const s of open.filter((x) => !x.drawerId)) {
    rows.push({
      id: `session:${s.id}`, name: sessionName(s, null), location: LOCATION_OF[s.area as DrawerArea] ?? "OFFICE", active: true, defaultFloat: 0,
      open: { sessionId: s.id, staff: staffName(s.userId), since: s.openedAt, balance: await drawerBalanceTx(prisma, s.id) }, lastClose: null,
    });
  }
  return {
    tills: rows,
    ...(await cashSummary()),
    pendingApprovals: await prisma.cashDrawerSession.count({ where: { status: "PENDING_APPROVAL" } }),
    canDeposit: can(actor, "cash.reconcile"),
  };
}

/**
 * RN-5 Owner dashboard: cash collected today (cash payments), cash in the drawers now (open sessions' balances plus
 * the float left in closed tills) and cash in the safe.
 */
export async function cashSummary(): Promise<{ collectedTodayPaise: number; inDrawersNowPaise: number; inSafePaise: number }> {
  const [from, to] = istDayRange(istDate(clock.now()));
  const agg = await prisma.payment.aggregate({ where: { method: "CASH", type: "PAYMENT", status: "SUCCEEDED", occurredAt: { gte: from, lt: to } }, _sum: { amount: true } });
  const open = await prisma.cashDrawerSession.findMany({ where: { closedAt: null }, select: { id: true, drawerId: true } });
  let inDrawers = 0;
  for (const s of open) inDrawers += await drawerBalanceTx(prisma, s.id);
  const busy = new Set(open.map((s) => s.drawerId));
  for (const t of await prisma.cashDrawer.findMany({ select: { id: true } })) {
    if (busy.has(t.id)) continue;
    inDrawers += (await lastClosedOf(prisma, t.id))?.floatCarried ?? 0;
  }
  return { collectedTodayPaise: agg._sum.amount ?? 0, inDrawersNowPaise: inDrawers, inSafePaise: await safeBalanceTx(prisma) };
}

// ───────────── safe and bank deposits (§2.6) ─────────────

export const bankDepositSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  depositDate: z.string().refine(isValidDateStr, "Enter the deposit date."),
  slipRef: z.string().trim().min(3, "Enter the deposit slip reference.").max(80),
  photoUrl: z.string().regex(/^\/api\/uploads\/deposit\/[a-z0-9]{24}\.(png|jpg|webp|pdf)$/, "Upload the slip first.").optional().nullable(),
  note: z.string().trim().max(200).optional(),
});

/** Bank deposit from the safe (Owner, Manager, Accountant): amount, date, slip reference, optional slip photo. */
export async function recordBankDeposit(actor: Actor, raw: z.input<typeof bankDepositSchema>) {
  assertCan(actor, "cash.reconcile");
  const input = bankDepositSchema.parse(raw);
  if (input.depositDate > istDate(clock.now())) throw new DomainError("VALIDATION_FAILED", "The deposit date can't be in the future.");
  return withTx(async (tx) => {
    const dep = await tx.bankDeposit.create({
      data: { amount: input.amount, depositDate: dbDate(input.depositDate), slipRef: input.slipRef, photoUrl: input.photoUrl ?? null, note: input.note ?? null, source: "SAFE", recordedBy: actorId(actor) },
    });
    const m = await appendSafe(tx, { type: "BANK_DEPOSIT", amount: -input.amount, actor, bankDepositId: dep.id, reference: input.slipRef, note: input.note ?? null });
    await audit(tx, actor, "safe.bank_deposit", "bank_deposit", dep.id, { after: { amount: input.amount, depositDate: input.depositDate, slipRef: input.slipRef, safeAfter: m.balanceAfter } });
    return { ...dep, depositDate: input.depositDate, safeBalance: m.balanceAfter };
  });
}

/** The safe: balance, its movements (newest first) and the bank deposits. */
export async function safeSummary(actor: Actor) {
  assertCan(actor, "cash.reconcile");
  const movements = await prisma.safeMovement.findMany({ orderBy: { lineNo: "desc" }, take: 100 });
  const people = await prisma.user.findMany({ where: { id: { in: movements.map((m) => m.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const deposits = await prisma.bankDeposit.findMany({ orderBy: [{ depositDate: "desc" }, { createdAt: "desc" }], take: 50 });
  return {
    balance: await safeBalanceTx(prisma),
    movements: movements.map((m) => ({ ...m, actor: people.find((p) => p.id === m.actorId)?.name ?? null })),
    deposits: deposits.map((d) => ({ ...d, depositDate: fromDbDate(d.depositDate) })),
  };
}

export const depositSchema = z.object({ amount: z.number().int().positive(), reference: z.string().trim().min(3).max(80) });

/**
 * v3 (kept for its callers): the bank deposit of one closed session's cash. A v4 session's counted cash went to the
 * safe at close (unless carried), so the deposit comes out of the safe; a session closed before v4 (no closing split)
 * is deposited directly, as before.
 */
export async function recordDeposit(actor: Actor, sessionId: string, raw: z.infer<typeof depositSchema>) {
  assertCan(actor, "cash.reconcile");
  const input = depositSchema.parse(raw);
  return withTx(async (tx) => {
    const d = await tx.cashDrawerSession.findUnique({ where: { id: sessionId } });
    if (!d) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
    if (!d.closedAt) throw new DomainError("VALIDATION_FAILED", "Close the drawer before recording its bank deposit.");
    if (d.depositedAt) throw new DomainError("VALIDATION_FAILED", "This drawer's deposit is already recorded.");
    if (input.amount > (d.cashCounted ?? 0)) throw new DomainError("VALIDATION_FAILED", `The deposit can't exceed the cash counted (${formatINR(d.cashCounted ?? 0)}).`);
    const now = clock.now();
    const fromSafe = d.cashDropped !== null;
    const dep = await tx.bankDeposit.create({
      data: { amount: input.amount, depositDate: dbDate(istDate(now)), slipRef: input.reference, source: fromSafe ? "SAFE" : "SESSION", sessionId: d.id, recordedBy: actorId(actor) },
    });
    if (fromSafe) {
      await appendSafe(tx, { type: "BANK_DEPOSIT", amount: -input.amount, actor, bankDepositId: dep.id, reference: input.reference, note: `Deposit of ${sessionName(d, await tillOf(tx, d.drawerId))}` });
    }
    const u = await tx.cashDrawerSession.update({ where: { id: d.id }, data: { depositAmount: input.amount, depositRef: input.reference, depositedAt: now, depositedBy: actorId(actor) } });
    await audit(tx, actor, "drawer.deposit", "cash_drawer_session", d.id, { after: { amount: input.amount, reference: input.reference, bankDepositId: dep.id, fromSafe } });
    return u;
  });
}

// ───────────── daily cash reconciliation (§2.6) ─────────────

export type RecLine = { key: string; label: string; expected: number; actual: number; difference: number; ok: boolean; href: string | null; detail: string };

/**
 * The daily reconciliation. Every line reconciles or shows its difference with a link: cash payments in the ledger
 * vs CASH_SALE movements, cash refunds vs CASH_REFUND movements, drops vs the safe, pay-ins vs the safe, sessions with
 * a variance, float handovers (left at close vs counted at the next open) and deposits vs the safe.
 */
export async function dailyCashReconciliation(actor: Actor, date?: string) {
  assertCan(actor, "cash.reconcile");
  const day = date && isValidDateStr(date) ? date : istDate(clock.now());
  const [from, to] = istDayRange(day);
  const settings = await getSettings();
  const sessions = await prisma.cashDrawerSession.findMany({ where: { openedAt: { gte: from, lt: to } }, orderBy: { openedAt: "asc" } });
  const users = await prisma.user.findMany({ where: { id: { in: sessions.map((s) => s.userId) } }, select: { id: true, name: true, role: true } });
  const tills = await prisma.cashDrawer.findMany();
  const rows = [];
  for (const s of sessions) {
    const live = await drawerTotals(prisma, s.id);
    const u = users.find((x) => x.id === s.userId);
    rows.push({
      ...s, name: u?.name ?? "?", role: u?.role ?? null, drawerName: sessionName(s, tills.find((t) => t.id === s.drawerId) ?? null),
      cashExpected: s.cashExpected ?? (await drawerBalanceTx(prisma, s.id)), cardTotal: s.cardTotal ?? live.card, upiTotal: s.upiTotal ?? live.upi,
      open: !s.closedAt,
    });
  }
  const closed = rows.filter((r) => !r.open);
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const lines: RecLine[] = [];
  const line = (key: string, label: string, expected: number, actual: number, href: string | null, detail: string) =>
    lines.push({ key, label, expected, actual, difference: actual - expected, ok: actual === expected, href, detail });

  // Ledger cash vs drawer movements, matched payment by payment.
  const matched = await prisma.$queryRaw<{ kind: string; payment_id: string; ledger: number; moved: number; customer: string | null }[]>(Prisma.sql`
    WITH l AS (
      SELECT le.payment_id, le.amount FROM ledger_entries le
       WHERE le.method = 'CASH' AND le.direction = 'IN' AND le.payment_id IS NOT NULL AND le.occurred_at >= ${from} AND le.occurred_at < ${to}),
    m AS (
      SELECT dm.payment_id, dm.amount FROM drawer_movements dm
       WHERE dm.type IN ('CASH_SALE', 'CASH_REFUND') AND dm.at >= ${from} AND dm.at < ${to})
    SELECT CASE WHEN COALESCE(l.amount, m.amount) > 0 THEN 'SALE' ELSE 'REFUND' END AS kind,
           COALESCE(l.payment_id, m.payment_id) AS payment_id, COALESCE(l.amount, 0)::int AS ledger, COALESCE(m.amount, 0)::int AS moved,
           b.customer_name AS customer
      FROM l FULL OUTER JOIN m ON m.payment_id = l.payment_id
      LEFT JOIN payments p ON p.id = COALESCE(l.payment_id, m.payment_id)
      LEFT JOIN bills b ON b.id = p.bill_id`);
  const sales = matched.filter((r) => r.kind === "SALE");
  const refunds = matched.filter((r) => r.kind === "REFUND");
  const badSales = sales.filter((r) => r.ledger !== r.moved);
  const badRefunds = refunds.filter((r) => r.ledger !== r.moved);
  line("cash_sales", "Cash payments in the ledger vs CASH_SALE movements", sum(sales, (r) => r.ledger), sum(sales, (r) => r.moved),
    badSales.length ? `/app/finance/ledger?method=CASH&range=CUSTOM&from=${day}&to=${day}` : null,
    badSales.length
      ? `${badSales.length} not matched: ${badSales.slice(0, 5).map((r) => `${r.customer ?? "?"} ${formatINR(r.ledger || r.moved)}`).join(", ")}`
      : `${sales.length} cash payment${sales.length === 1 ? "" : "s"}, each in a drawer`);
  line("cash_refunds", "Cash refunds in the ledger vs CASH_REFUND movements", -sum(refunds, (r) => r.ledger), -sum(refunds, (r) => r.moved),
    badRefunds.length ? "/app/refunds" : null,
    badRefunds.length ? `${badRefunds.length} refund${badRefunds.length === 1 ? "" : "s"} not matched to a drawer` : `${refunds.length} cash refund${refunds.length === 1 ? "" : "s"}, each from a drawer`);

  // Drops and pay-ins vs the safe.
  const [dr] = await prisma.$queryRaw<{ dropped: number; safe_in: number; pay_in: number; safe_out: number; drops: number; pay_ins: number }[]>(Prisma.sql`
    SELECT COALESCE(-sum(dm.amount) FILTER (WHERE dm.type = 'CASH_DROP'), 0)::int AS dropped,
           COALESCE(sum(sm.amount) FILTER (WHERE dm.type = 'CASH_DROP'), 0)::int AS safe_in,
           COALESCE(sum(dm.amount) FILTER (WHERE dm.type = 'PAY_IN'), 0)::int AS pay_in,
           COALESCE(-sum(sm.amount) FILTER (WHERE dm.type = 'PAY_IN'), 0)::int AS safe_out,
           count(*) FILTER (WHERE dm.type = 'CASH_DROP')::int AS drops,
           count(*) FILTER (WHERE dm.type = 'PAY_IN')::int AS pay_ins
      FROM drawer_movements dm LEFT JOIN safe_movements sm ON sm.drawer_movement_id = dm.id
     WHERE dm.type IN ('CASH_DROP', 'PAY_IN') AND dm.at >= ${from} AND dm.at < ${to}`);
  line("drops", "Cash drops from drawers vs cash into the safe", dr.dropped, dr.safe_in, dr.dropped !== dr.safe_in ? "/app/finance/drawers" : null, `${dr.drops} drop${dr.drops === 1 ? "" : "s"}`);
  line("pay_ins", "Pay-ins into drawers vs cash out of the safe", dr.pay_in, dr.safe_out, dr.pay_in !== dr.safe_out ? "/app/finance/drawers" : null, `${dr.pay_ins} pay-in${dr.pay_ins === 1 ? "" : "s"}`);

  // Sessions with a variance: reconciled when within the tolerance or approved.
  for (const r of closed.filter((x) => (x.variance ?? 0) !== 0)) {
    lines.push({
      key: `variance:${r.id}`, label: `Variance · ${r.drawerName} · ${r.name}`, expected: r.cashExpected ?? 0, actual: r.cashCounted ?? 0, difference: r.variance ?? 0,
      ok: r.status === "APPROVED" || (r.status === "CLOSED" && Math.abs(r.variance ?? 0) <= settings.drawer_variance_tolerance),
      href: `/app/finance/drawers/${r.id}`, detail: `${r.status.replace("_", " ").toLowerCase()}${r.varianceReason ? ` · ${r.varianceReason}` : ""}`,
    });
  }

  // CD-8 handovers: what the previous session left in the till vs what the next person counted.
  for (const r of rows) {
    if (!r.drawerId) continue;
    const prev = await prisma.cashDrawerSession.findFirst({ where: { drawerId: r.drawerId, id: { not: r.id }, closedAt: { not: null, lte: r.openedAt } }, orderBy: { closedAt: "desc" } });
    if (!prev || prev.floatCarried === null || prev.floatCarried === r.openingFloat) continue;
    lines.push({
      key: `handover:${r.id}`, label: `Handover · ${r.drawerName} · ${r.name}`, expected: prev.floatCarried, actual: r.openingFloat, difference: r.openingFloat - prev.floatCarried,
      ok: false, href: `/app/finance/drawers/${r.id}`, detail: "left in the till at the previous close vs counted at this open",
    });
  }

  // Bank deposits vs the safe.
  const deposits = await prisma.bankDeposit.findMany({ where: { depositDate: dbDate(day) }, orderBy: { createdAt: "asc" } });
  const fromSafe = deposits.filter((d) => d.source === "SAFE");
  const safeOut = await prisma.safeMovement.aggregate({ where: { type: "BANK_DEPOSIT", bankDepositId: { in: fromSafe.map((d) => d.id) } }, _sum: { amount: true } });
  line("deposits", "Bank deposits vs cash out of the safe", sum(fromSafe, (d) => d.amount), -(safeOut._sum.amount ?? 0), null, `${deposits.length} deposit${deposits.length === 1 ? "" : "s"}`);

  const safeStart = await prisma.safeMovement.findFirst({ where: { at: { lt: from } }, orderBy: { lineNo: "desc" } });
  const safeEnd = await prisma.safeMovement.findFirst({ where: { at: { lt: to } }, orderBy: { lineNo: "desc" } });
  return {
    date: day,
    sessions: rows,
    lines,
    safe: { start: safeStart?.balanceAfter ?? 0, end: safeEnd?.balanceAfter ?? 0, now: await safeBalanceTx(prisma) },
    deposits: deposits.map((d) => ({ ...d, depositDate: fromDbDate(d.depositDate) })),
    totals: {
      expected: closed.reduce((a, r) => a + (r.cashExpected ?? 0), 0),
      counted: closed.reduce((a, r) => a + (r.cashCounted ?? 0), 0),
      variance: closed.reduce((a, r) => a + (r.variance ?? 0), 0),
      card: rows.reduce((a, r) => a + (r.cardTotal ?? 0), 0),
      upi: rows.reduce((a, r) => a + (r.upiTotal ?? 0), 0),
      deposited: sum(deposits, (d) => d.amount),
      openDrawers: rows.length - closed.length,
      unreconciled: lines.filter((l) => !l.ok).length,
    },
  };
}
