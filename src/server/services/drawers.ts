// Cash drawer sessions (completion pass 8.4; generalises the bar's E-15 to the desk and the shop).
// Open with a float → every cash/card/UPI payment or refund taken by that person links to the session →
// close with the counted cash → the variance is stored. The accountant reconciles each day and records deposits.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { istDate, istDayRange, isValidDateStr } from "@/lib/time";
import { prisma, pgErrorCode, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { notify } from "./notifications";

export const DRAWER_AREAS = ["DESK", "SHOP", "BAR", "OFFICE"] as const;

function userOf(actor: Actor): string {
  if (actor.kind !== "USER") throw new DomainError("FORBIDDEN", "Only staff members have cash drawers.");
  return actor.userId;
}

/** The open drawer of a staff member, if any. */
export async function currentDrawer(db: Tx | typeof prisma, actor: Actor) {
  if (actor.kind !== "USER") return null;
  return db.cashDrawerSession.findFirst({ where: { userId: actor.userId, closedAt: null } });
}

/** Counter payments and refunds by staff need an open drawer (8.4). Jobs and the gateway don't. */
export async function requireDrawer(tx: Tx, actor: Actor): Promise<string | null> {
  if (actor.kind !== "USER") return null;
  const d = await currentDrawer(tx, actor);
  if (!d) {
    throw new DomainError("DRAWER_NOT_OPEN", "Open your cash drawer (with the starting float) before taking or returning payments.", { userId: actor.userId });
  }
  return d.id;
}

export const openDrawerSchema = z.object({
  area: z.enum(DRAWER_AREAS),
  openingFloat: z.number().int().min(0).max(10_000_000),
});

export async function openDrawer(actor: Actor, raw: z.infer<typeof openDrawerSchema>, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = openDrawerSchema.parse(raw);
  const userId = userOf(actor);
  return withTx(async (tx) => {
    try {
      const d = await tx.cashDrawerSession.create({ data: { userId, area: input.area, openingFloat: input.openingFloat, openedAt: clock.now() } });
      await audit(tx, actor, "drawer.open", "cash_drawer_session", d.id, { after: { area: input.area, openingFloat: input.openingFloat } });
      return d;
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", "Your cash drawer is already open. Close it before opening a new one.");
      throw e;
    }
  }, outer);
}

export const COLLECTION_METHODS = ["CASH", "UPI", "CARD", "ONLINE"] as const;

/**
 * v3 §5.1: what the session collected, by method (count + amount), and what should physically be in the drawer.
 * Only cash is in the drawer: expected = float + cash payments − cash refunds (refund pay-outs are the only cash that
 * leaves a drawer; expenses and salaries paid in cash are paid from the office, not from a counter drawer).
 */
async function drawerTotals(db: Tx | typeof prisma, sessionId: string, openingFloat: number) {
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
    cashExpected: openingFloat + sum("CASH", "PAYMENT") - sum("CASH", "REFUND"),
    card: sum("CARD", "PAYMENT") - sum("CARD", "REFUND"),
    upi: sum("UPI", "PAYMENT") - sum("UPI", "REFUND"),
  };
}

export const closeDrawerSchema = z.object({ cashCounted: z.number().int().min(0), note: z.string().max(300).optional() });

/** Close the actor's drawer: expected = float + cash taken − cash refunded; variance = counted − expected. */
export async function closeDrawer(actor: Actor, raw: z.infer<typeof closeDrawerSchema>, outer?: Tx) {
  assertCan(actor, "staff.self");
  const input = closeDrawerSchema.parse(raw);
  const userId = userOf(actor);
  return withTx(async (tx) => {
    const d = await tx.cashDrawerSession.findFirst({ where: { userId, closedAt: null } });
    if (!d) throw new DomainError("DRAWER_NOT_OPEN", "You have no open cash drawer.");
    await tx.$queryRaw`SELECT id FROM cash_drawer_sessions WHERE id = ${d.id} FOR UPDATE`;
    const t = await drawerTotals(tx, d.id, d.openingFloat);
    const variance = input.cashCounted - t.cashExpected;
    const closed = await tx.cashDrawerSession.update({
      where: { id: d.id },
      data: { closedAt: clock.now(), closedBy: userId, cashExpected: t.cashExpected, cashCounted: input.cashCounted, variance, cardTotal: t.card, upiTotal: t.upi, note: input.note ?? null },
    });
    await audit(tx, actor, "drawer.close", "cash_drawer_session", d.id, { after: { cashExpected: t.cashExpected, cashCounted: input.cashCounted, variance } });
    if (variance !== 0) {
      await notify(tx, {
        roles: ["MANAGER", "OWNER", "ACCOUNTANT"], type: "CASH_VARIANCE", title: `Cash variance ${formatINR(variance)}`,
        body: `${actor.kind === "USER" ? actor.name : "Staff"} closed the ${d.area.toLowerCase()} drawer: expected ${formatINR(t.cashExpected)}, counted ${formatINR(input.cashCounted)}.`,
        link: "/app/finance/cash", dedupeKey: `cash-variance:${d.id}`,
      });
    }
    return closed;
  }, outer);
}

/** The caller's drawer with live totals (for the "my drawer" panel). */
export async function myDrawer(actor: Actor) {
  assertCan(actor, "staff.self");
  const d = await currentDrawer(prisma, actor);
  if (!d) return { open: null };
  return { open: { ...d, ...(await drawerTotals(prisma, d.id, d.openingFloat)) } };
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

/** Accountant's daily reconciliation: every drawer session opened that IST day, with totals and deposits. */
export async function dailyCashReconciliation(actor: Actor, date?: string) {
  assertCan(actor, "cash.reconcile");
  const day = date && isValidDateStr(date) ? date : istDate(clock.now());
  const [from, to] = istDayRange(day);
  const sessions = await prisma.cashDrawerSession.findMany({ where: { openedAt: { gte: from, lt: to } }, orderBy: { openedAt: "asc" } });
  const users = await prisma.user.findMany({ where: { id: { in: sessions.map((s) => s.userId) } }, select: { id: true, name: true, role: true } });
  const rows = [];
  for (const s of sessions) {
    const live = await drawerTotals(prisma, s.id, s.openingFloat);
    const u = users.find((x) => x.id === s.userId);
    rows.push({
      ...s, name: u?.name ?? "?", role: u?.role ?? null,
      cashExpected: s.cashExpected ?? live.cashExpected, cardTotal: s.cardTotal ?? live.card, upiTotal: s.upiTotal ?? live.upi,
      open: !s.closedAt,
    });
  }
  const closed = rows.filter((r) => !r.open);
  return {
    date: day,
    sessions: rows,
    totals: {
      expected: closed.reduce((a, r) => a + (r.cashExpected ?? 0), 0),
      counted: closed.reduce((a, r) => a + (r.cashCounted ?? 0), 0),
      variance: closed.reduce((a, r) => a + (r.variance ?? 0), 0),
      card: rows.reduce((a, r) => a + (r.cardTotal ?? 0), 0),
      upi: rows.reduce((a, r) => a + (r.upiTotal ?? 0), 0),
      deposited: rows.reduce((a, r) => a + (r.depositAmount ?? 0), 0),
      openDrawers: rows.length - closed.length,
    },
  };
}

export const depositSchema = z.object({ amount: z.number().int().positive(), reference: z.string().trim().min(3).max(80) });

/** Record the bank deposit of a closed drawer's cash (accountant). */
export async function recordDeposit(actor: Actor, sessionId: string, raw: z.infer<typeof depositSchema>) {
  assertCan(actor, "cash.reconcile");
  const input = depositSchema.parse(raw);
  return withTx(async (tx) => {
    const d = await tx.cashDrawerSession.findUnique({ where: { id: sessionId } });
    if (!d) throw new DomainError("NOT_FOUND", "Drawer session was not found.");
    if (!d.closedAt) throw new DomainError("VALIDATION_FAILED", "Close the drawer before recording its bank deposit.");
    if (d.depositedAt) throw new DomainError("VALIDATION_FAILED", "This drawer's deposit is already recorded.");
    if (input.amount > (d.cashCounted ?? 0)) throw new DomainError("VALIDATION_FAILED", `The deposit can't exceed the cash counted (${formatINR(d.cashCounted ?? 0)}).`);
    const u = await tx.cashDrawerSession.update({ where: { id: d.id }, data: { depositAmount: input.amount, depositRef: input.reference, depositedAt: clock.now(), depositedBy: actorId(actor) } });
    await audit(tx, actor, "drawer.deposit", "cash_drawer_session", d.id, { after: { amount: input.amount, reference: input.reference } });
    return u;
  });
}
