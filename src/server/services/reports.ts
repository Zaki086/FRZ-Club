// Reports & owner dashboard (plan §5.15 DB-1…DB-6; R-38, R-39, R-44, R-45, R-46; E-18, E-19).
// Money numbers read only the ledger and bills, so every KPI equals the sum of its drill-down rows.
import type { LedgerSource, PaymentMethod, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR, roundDiv } from "@/lib/money";
import {
  addDays, dateRangeInclusive, daysInMonth, diffDays, fmtDateTime, istDate, istParts, istToUtc, isValidDateStr, monthStart, timeToMinutes, weekStart,
} from "@/lib/time";
import { prisma, withTx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue } from "./bills";
import { splitTax } from "./invoices";
import { getSettings } from "./settings";
import { INDIAN_STATES } from "@/lib/states";
import { resolveRange, type DatePreset } from "./filters/core";
import { assertCapability } from "./capabilities";
import { refundsPayableSummary } from "./refunds";

export const INCOME_SOURCES: LedgerSource[] = ["COURTS", "SOCIAL", "SHOP", "BAR", "MEMBERSHIP", "INVOICE"];
export const METHODS: PaymentMethod[] = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "ONLINE"];

// ───────────── periods (DB-1) ─────────────

export const periodSchema = z.object({
  period: z.enum(["TODAY", "WEEK", "MONTH", "CUSTOM"]).default("TODAY"),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type PeriodInput = z.input<typeof periodSchema>;
export type Period = { key: string; label: string; from: string; to: string; prevFrom: string; prevTo: string };

/** [from, to] inclusive IST dates and the previous equivalent period (same length, immediately comparable). */
export function resolvePeriod(raw: PeriodInput, today = istDate(clock.now())): Period {
  const p = periodSchema.parse(raw);
  if (p.period === "TODAY") return { key: "TODAY", label: "Today", from: today, to: today, prevFrom: addDays(today, -1), prevTo: addDays(today, -1) };
  if (p.period === "WEEK") {
    const from = weekStart(today);
    const len = diffDays(from, today);
    return { key: "WEEK", label: "This week", from, to: today, prevFrom: addDays(from, -7), prevTo: addDays(from, -7 + len) };
  }
  if (p.period === "MONTH") {
    const from = monthStart(today);
    const [y, m] = from.split("-").map(Number);
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const [py, pm] = prevMonth.split("-").map(Number);
    const day = Math.min(Number(today.slice(8, 10)), daysInMonth(py, pm));
    return { key: "MONTH", label: "This month", from, to: today, prevFrom: `${prevMonth}-01`, prevTo: `${prevMonth}-${String(day).padStart(2, "0")}` };
  }
  if (!p.from || !p.to || !isValidDateStr(p.from) || !isValidDateStr(p.to) || p.to < p.from) {
    throw new DomainError("VALIDATION_FAILED", "Custom periods need a valid from and to date (from ≤ to).");
  }
  const len = diffDays(p.from, p.to);
  return { key: "CUSTOM", label: `${p.from} → ${p.to}`, from: p.from, to: p.to, prevFrom: addDays(p.from, -(len + 1)), prevTo: addDays(p.from, -1) };
}

const bounds = (from: string, to: string): [Date, Date] => [istToUtc(from), istToUtc(addDays(to, 1))];

const pct = (cur: number, prev: number): number | null => (prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);

// ───────────── ledger aggregates ─────────────

async function ledgerSums(from: string, to: string) {
  const [a, b] = bounds(from, to);
  const rows = await prisma.ledgerEntry.groupBy({ by: ["source", "method", "direction"], where: { occurredAt: { gte: a, lt: b } }, _sum: { amount: true, taxAmount: true } });
  const income = rows.filter((r) => r.direction === "IN");
  const bySource = Object.fromEntries(INCOME_SOURCES.map((s) => [s, income.filter((r) => r.source === s).reduce((x, r) => x + (r._sum.amount ?? 0), 0)])) as Record<string, number>;
  const byMethod = Object.fromEntries(METHODS.map((m) => [m, income.filter((r) => r.method === m).reduce((x, r) => x + (r._sum.amount ?? 0), 0)])) as Record<string, number>;
  const collected = income.reduce((x, r) => x + (r._sum.amount ?? 0), 0);
  const expenses = -rows.filter((r) => r.source === "EXPENSE").reduce((x, r) => x + (r._sum.amount ?? 0), 0);
  const payroll = -rows.filter((r) => r.source === "PAYROLL").reduce((x, r) => x + (r._sum.amount ?? 0), 0);
  const gstCollected = income.reduce((x, r) => x + (r._sum.taxAmount ?? 0), 0);
  return { collected, bySource, byMethod, expenses, payroll, netCashFlow: collected - expenses - payroll, gstCollected };
}

/** "What we are owed" (EX-2): unpaid customer bills (member dues, pay-at-pickup orders, business invoices). */
async function receivables() {
  const bills = await prisma.bill.findMany({ where: { closedAt: null, status: { in: ["UNPAID", "PARTIAL", "PARTIALLY_REFUNDED"] } } });
  const invoices = await prisma.invoice.findMany({ where: { billId: { in: bills.map((b) => b.id) } }, select: { billId: true, status: true } });
  const counted = bills.filter((b) => {
    if (b.sourceType !== "INVOICE") return billDue(b) > 0;
    const inv = invoices.find((i) => i.billId === b.id);
    return !!inv && inv.status !== "DRAFT" && inv.status !== "CANCELLED" && billDue(b) > 0;
  });
  return { total: counted.reduce((a, b) => a + billDue(b), 0), count: counted.length, rows: counted };
}

/** "What we owe" (EX-2): unpaid expense bills + approved unpaid payroll + GST collected this period (estimate)
 *  + v4 RF-10 refunds payable (approved refunds waiting to be collected at the desk; they never expire). */
async function payables(gstThisPeriod: number) {
  const [exp, runs, rf] = await Promise.all([
    prisma.expenseBill.findMany({ where: { status: "UNPAID" } }),
    prisma.payrollRun.findMany({ where: { status: "APPROVED" }, include: { payslips: true } }),
    refundsPayableSummary(),
  ]);
  const expenses = exp.reduce((a, e) => a + e.amount, 0);
  const payroll = runs.reduce((a, r) => a + r.payslips.reduce((x, p) => x + p.net, 0), 0);
  return {
    total: expenses + payroll + gstThisPeriod + rf.amountPaise, expenses, payroll, gst: gstThisPeriod, expenseCount: exp.length, payrollRuns: runs.length,
    refunds: rf.amountPaise, refundCount: rf.count, refundOldestDays: rf.oldestDays,
  };
}

// ───────────── operational aggregates ─────────────

async function bookingStats(from: string, to: string) {
  const [a, b] = bounds(from, to);
  const rows = await prisma.booking.groupBy({ by: ["status"], where: { reservation: { startAt: { gte: a, lt: b } } }, _count: { _all: true } });
  const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return { total: rows.reduce((x, r) => x + r._count._all, 0), cancelled: n("CANCELLED") + n("CANCELLED_BY_CLUB"), cancelledByClub: n("CANCELLED_BY_CLUB"), noShows: n("NO_SHOW"), completed: n("COMPLETED"), confirmed: n("CONFIRMED") };
}

/** Booked court-hours ÷ open court-hours (social counts as booked; maintenance does not count either way). */
export async function utilization(from: string, to: string) {
  const s = await getSettings();
  const courts = await prisma.court.findMany({ where: { active: true, archivedAt: null } });
  const openMin = timeToMinutes(s.opening_hours.close) - timeToMinutes(s.opening_hours.open);
  const days = dateRangeInclusive(from, to).length;
  const [a, b] = bounds(from, to);
  const res = await prisma.courtReservation.findMany({ where: { status: "ACTIVE", kind: { in: ["REGULAR", "SOCIAL"] }, startAt: { gte: a, lt: b }, courtId: { in: courts.map((c) => c.id) } } });
  const bookedMin = res.reduce((x, r) => x + (r.endAt.getTime() - r.startAt.getTime()) / 60_000, 0);
  const openTotal = courts.length * openMin * days;
  // heatmap: court × hour-of-day booked minutes over the period
  const heat: Record<string, Record<number, number>> = {};
  for (const c of courts) heat[c.name] = {};
  for (const r of res) {
    const c = courts.find((x) => x.id === r.courtId)!;
    for (let t = r.startAt.getTime(); t < r.endAt.getTime(); t += 30 * 60_000) {
      const h = istParts(new Date(t)).hour;
      heat[c.name][h] = (heat[c.name][h] ?? 0) + 30;
    }
  }
  const startH = Math.floor(timeToMinutes(s.opening_hours.open) / 60);
  const endH = Math.ceil(timeToMinutes(s.opening_hours.close) / 60);
  return {
    pct: openTotal ? Math.round((bookedMin / openTotal) * 1000) / 10 : 0,
    bookedHours: Math.round((bookedMin / 60) * 10) / 10,
    openHours: Math.round((openTotal / 60) * 10) / 10,
    heatmap: { hours: Array.from({ length: endH - startH }, (_, i) => startH + i), courts: courts.map((c) => ({ court: c.name, cells: Array.from({ length: endH - startH }, (_, i) => Math.round(((heat[c.name][startH + i] ?? 0) / (60 * days)) * 100)) })) },
  };
}

async function memberStats(from: string, to: string) {
  const s = await getSettings();
  const today = istDate(clock.now());
  const [a, b] = bounds(from, to);
  const active = await prisma.$queryRaw<{ code: string; n: number }[]>`
    SELECT p.code::text AS code, count(DISTINCT m.member_id)::int AS n FROM memberships m JOIN plans p ON p.id = m.plan_id
     WHERE m.status NOT IN ('PENDING_PAYMENT', 'CANCELLED') AND m.start_date <= ${today}::date AND m.end_date >= ${today}::date GROUP BY 1`;
  const newMembers = await prisma.member.count({ where: { createdAt: { gte: a, lt: b } } });
  const expiring = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memberships m
     WHERE m.status = 'ACTIVE' AND m.end_date BETWEEN ${today}::date AND ${addDays(today, s.expiring_soon_days)}::date
       AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x.member_id = m.member_id AND x.id <> m.id AND x.status IN ('ACTIVE','SCHEDULED') AND x.end_date > m.end_date)`;
  const byTier = { GOLD: 0, SILVER: 0, JUNIOR: 0 } as Record<string, number>;
  for (const r of active) byTier[r.code] = r.n;
  return { activeByTier: byTier, activeTotal: Object.values(byTier).reduce((x, y) => x + y, 0), newMembers, expiringSoon: expiring[0]?.n ?? 0 };
}

async function shopStats(from: string, to: string) {
  const [a, b] = bounds(from, to);
  const lines = await prisma.billLine.findMany({
    where: { voidedAt: null, variantId: { not: null }, bill: { sourceType: { in: ["COUNTER_SALE", "SHOP_ORDER"] }, closedAt: null, status: { in: ["PAID", "PARTIALLY_REFUNDED"] }, createdAt: { gte: a, lt: b } } },
    select: { variantId: true, qty: true, netAmount: true, description: true },
  });
  const agg = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const l of lines) {
    const cur = agg.get(l.variantId!) ?? { name: l.description, qty: 0, revenue: 0 };
    cur.qty += l.qty;
    cur.revenue += l.netAmount;
    agg.set(l.variantId!, cur);
  }
  const low = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.track_stock AND p.archived_at IS NULL AND v.archived_at IS NULL AND v.on_hand - v.reserved <= v.reorder_level`;
  const openOrders = await prisma.shopOrder.count({ where: { status: { notIn: ["COLLECTED", "DELIVERED", "CANCELLED"] } } });
  return { topProducts: [...agg.values()].sort((x, y) => y.qty - x.qty || y.revenue - x.revenue).slice(0, 5), lowStock: low[0]?.n ?? 0, openOrders };
}

async function barStats(from: string, to: string) {
  const [a, b] = bounds(from, to);
  const settled = await prisma.tab.findMany({ where: { status: "SETTLED", settledAt: { gte: a, lt: b } } });
  const bills = await prisma.bill.findMany({ where: { id: { in: settled.map((t) => t.billId) } }, select: { total: true } });
  const openTabs = await prisma.tab.count({ where: { status: "OPEN" } });
  return { averageTab: bills.length ? Math.round(bills.reduce((x, y) => x + y.total, 0) / bills.length) : 0, settledTabs: settled.length, openTabs };
}

async function leadStats(from: string, to: string) {
  const [a, b] = bounds(from, to);
  const created = await prisma.lead.findMany({ where: { createdAt: { gte: a, lt: b } }, select: { status: true } });
  const overdue = await prisma.lead.count({ where: { status: { in: ["NEW", "CONTACTED", "QUOTED"] }, nextFollowUpAt: { lt: clock.now() } } });
  const won = created.filter((l) => l.status === "WON").length;
  return { newLeads: created.length, overdue, won, conversionRate: created.length ? Math.round((won / created.length) * 1000) / 10 : 0 };
}

/** DB-4: daily revenue stacked by source over the period (at least the last 7 days). */
async function dailyRevenue(from: string, to: string) {
  const start = diffDays(from, to) < 6 ? addDays(to, -6) : from;
  const [a, b] = bounds(start, to);
  const rows = await prisma.$queryRaw<{ d: string; source: string; total: number }[]>`
    SELECT to_char(occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d, source::text AS source, sum(amount)::int AS total
      FROM ledger_entries WHERE direction = 'IN' AND occurred_at >= ${a} AND occurred_at < ${b} GROUP BY 1, 2`;
  return dateRangeInclusive(start, to).map((d) => {
    const row: Record<string, number | string> = { date: d };
    for (const s of INCOME_SOURCES) row[s] = rows.find((r) => r.d === d && r.source === s)?.total ?? 0;
    return row;
  });
}

// ───────────── dashboard (DB-1…DB-6) ─────────────

export type DashboardScope = "FULL" | "OPS" | "DESK" | "SHOP" | "BAR" | "FINANCE";

export function dashboardScope(actor: Actor): DashboardScope {
  if (can(actor, "dashboard.full")) return "FULL";
  if (can(actor, "dashboard.ops")) return "OPS";
  if (can(actor, "dashboard.finance")) return "FINANCE";
  if (can(actor, "dashboard.bar")) return "BAR";
  if (can(actor, "dashboard.shop")) return "SHOP";
  if (can(actor, "dashboard.desk")) return "DESK";
  throw new DomainError("FORBIDDEN", "Not allowed: no dashboard for this role.");
}

export async function computeDashboard(scope: DashboardScope, raw: PeriodInput) {
  const p = resolvePeriod(scope === "DESK" ? { period: "TODAY" } : raw);
  const [cur, prev] = await Promise.all([ledgerSums(p.from, p.to), ledgerSums(p.prevFrom, p.prevTo)]);
  const money = {
    collected: { value: cur.collected, prev: prev.collected, change: pct(cur.collected, prev.collected) },
    bySource: Object.fromEntries(INCOME_SOURCES.map((s) => [s, { value: cur.bySource[s], prev: prev.bySource[s], change: pct(cur.bySource[s], prev.bySource[s]) }])),
    byMethod: Object.fromEntries(METHODS.map((m) => [m, { value: cur.byMethod[m], prev: prev.byMethod[m], change: pct(cur.byMethod[m], prev.byMethod[m]) }])),
    expenses: { value: cur.expenses, prev: prev.expenses, change: pct(cur.expenses, prev.expenses) },
    payroll: { value: cur.payroll, prev: prev.payroll, change: pct(cur.payroll, prev.payroll) },
    netCashFlow: { value: cur.netCashFlow, prev: prev.netCashFlow, change: pct(cur.netCashFlow, prev.netCashFlow) },
  };
  const [bk, bkPrev, util, members, shop, bar, leads, recv, pay, daily] = await Promise.all([
    bookingStats(p.from, p.to), bookingStats(p.prevFrom, p.prevTo), utilization(p.from, p.to), memberStats(p.from, p.to),
    shopStats(p.from, p.to), barStats(p.from, p.to), leadStats(p.from, p.to), receivables(), payables(cur.gstCollected), dailyRevenue(p.from, p.to),
  ]);
  const ops = {
    bookings: { value: bk.total, prev: bkPrev.total, change: pct(bk.total, bkPrev.total) },
    cancellations: { value: bk.cancelled, prev: bkPrev.cancelled, change: pct(bk.cancelled, bkPrev.cancelled) },
    noShows: { value: bk.noShows, prev: bkPrev.noShows, change: pct(bk.noShows, bkPrev.noShows) },
    // v3 CC-8: paid bookings the club cancelled that still wait for the player's choice (not period-bound).
    clubCancellationsPending: await prisma.clubCancellation.count({ where: { status: "PENDING_CHOICE" } }),
    utilization: util,
    members,
    shop,
    bar: { revenue: money.bySource.BAR, ...bar },
    leads,
  };
  const base = { period: p, scope, generatedAt: clock.now().toISOString() };
  switch (scope) {
    case "FULL":
      return { ...base, money, receivables: { total: recv.total, count: recv.count }, payables: pay, ops, daily };
    case "FINANCE":
      return { ...base, money, receivables: { total: recv.total, count: recv.count }, payables: pay, daily };
    case "OPS": {
      // DB-6: operations only — no payroll and no net figures.
      const { payroll: _p, netCashFlow: _n, ...rest } = money;
      void _p;
      void _n;
      return { ...base, money: rest, receivables: { total: recv.total, count: recv.count }, ops, daily };
    }
    case "BAR":
      return { ...base, money: { collected: money.bySource.BAR }, ops: { bar: ops.bar } };
    case "SHOP":
      return { ...base, money: { collected: money.bySource.SHOP }, ops: { shop: ops.shop } };
    case "DESK":
      return { ...base, money: { courts: money.bySource.COURTS, social: money.bySource.SOCIAL, memberships: money.bySource.MEMBERSHIP }, ops: { bookings: ops.bookings, noShows: ops.noShows, clubCancellationsPending: ops.clubCancellationsPending, utilization: ops.utilization, members: ops.members, leads: ops.leads } };
  }
}

export async function dashboard(actor: Actor, raw: PeriodInput) {
  return computeDashboard(dashboardScope(actor), raw);
}

// ───────────── drill-down (DB-3) ─────────────

const METRIC_SCOPE: Record<string, DashboardScope[]> = {
  collected: ["FULL", "FINANCE", "OPS"],
  expenses: ["FULL", "FINANCE", "OPS"],
  payroll: ["FULL", "FINANCE"],
  receivables: ["FULL", "FINANCE", "OPS"],
  bookings: ["FULL", "OPS", "DESK"],
  noShows: ["FULL", "OPS", "DESK"],
  cancellations: ["FULL", "OPS", "DESK"],
};

/**
 * Every money KPI clicks through to the ledger rows that sum to it. metric: collected | source:<S> | method:<M> |
 * expenses | payroll | receivables | bookings | noShows | cancellations.
 */
export async function drillDown(actor: Actor, metric: string, raw: PeriodInput) {
  const scope = dashboardScope(actor);
  const [kind, arg] = metric.split(":");
  const allowed = kind === "source" ? (arg === "BAR" ? ["FULL", "FINANCE", "OPS", "BAR"] : arg === "SHOP" ? ["FULL", "FINANCE", "OPS", "SHOP"] : ["FULL", "FINANCE", "OPS", "DESK"]) : kind === "method" ? ["FULL", "FINANCE", "OPS"] : METRIC_SCOPE[kind];
  if (!allowed) throw new DomainError("VALIDATION_FAILED", `Unknown metric ${metric}.`);
  if (!allowed.includes(scope)) throw new DomainError("FORBIDDEN", "Not allowed: this number is not on your dashboard.");
  const p = resolvePeriod(scope === "DESK" ? { period: "TODAY" } : raw);
  const [a, b] = bounds(p.from, p.to);
  if (["collected", "source", "method", "expenses", "payroll"].includes(kind)) {
    const where: Prisma.LedgerEntryWhereInput = { occurredAt: { gte: a, lt: b } };
    if (kind === "collected") where.direction = "IN";
    if (kind === "source") {
      if (!INCOME_SOURCES.includes(arg as LedgerSource)) throw new DomainError("VALIDATION_FAILED", `Unknown source ${arg}.`);
      where.direction = "IN";
      where.source = arg as LedgerSource;
    }
    if (kind === "method") {
      if (!METHODS.includes(arg as PaymentMethod)) throw new DomainError("VALIDATION_FAILED", `Unknown method ${arg}.`);
      where.direction = "IN";
      where.method = arg as PaymentMethod;
    }
    if (kind === "expenses") where.source = "EXPENSE";
    if (kind === "payroll") where.source = "PAYROLL";
    const rows = await prisma.ledgerEntry.findMany({ where, orderBy: { occurredAt: "asc" } });
    const sign = kind === "expenses" || kind === "payroll" ? -1 : 1;
    const out = rows.map((r) => ({ id: r.id, at: r.occurredAt, source: r.source, method: r.method, description: r.description, amount: sign * r.amount, billId: r.billId }));
    return { metric, period: p, kind: "money" as const, total: out.reduce((x, r) => x + r.amount, 0), rows: out };
  }
  if (kind === "receivables") {
    const r = await receivables();
    const rows = r.rows.map((b) => ({ id: b.id, at: b.createdAt, source: b.sourceType, method: null, description: b.customerName, amount: billDue(b), billId: b.id }));
    return { metric, period: p, kind: "money" as const, total: r.total, rows };
  }
  const statusWhere: Prisma.BookingWhereInput = kind === "noShows" ? { status: "NO_SHOW" } : kind === "cancellations" ? { status: { in: ["CANCELLED", "CANCELLED_BY_CLUB"] } } : {};
  const bookings = await prisma.booking.findMany({
    where: { ...statusWhere, reservation: { startAt: { gte: a, lt: b } } },
    include: { reservation: { include: { court: true } } },
    orderBy: { reservation: { startAt: "asc" } },
  });
  const rows = bookings.map((x) => ({ id: x.id, at: x.reservation.startAt, source: x.reservation.court.name, method: x.channel, description: `${x.bookingCode} · ${x.status}`, amount: 1, billId: x.billId }));
  return { metric, period: p, kind: "count" as const, total: rows.length, rows };
}

// ───────────── GST report (IN-6, R-44, E-21) ─────────────

/**
 * Report support, not a filing: GST in collections of the period (cash basis). Each bill's collection in the
 * period is spread over its lines; CGST/SGST for intra-state supplies, IGST for inter-state (IN-3).
 */
export async function gstReport(actor: Actor, raw: PeriodInput) {
  assertCan(actor, "gst");
  await assertCapability("gst");
  const p = resolvePeriod(raw);
  const s = await getSettings();
  const verified = (await prisma.setting.findUnique({ where: { key: "tax_rates" } }))?.verified ?? false;
  const [a, b] = bounds(p.from, p.to);
  const collections = await prisma.ledgerEntry.groupBy({ by: ["billId"], where: { direction: "IN", billId: { not: null }, occurredAt: { gte: a, lt: b } }, _sum: { amount: true } });
  const billIds = collections.map((c) => c.billId!).filter(Boolean);
  const bills = await prisma.bill.findMany({ where: { id: { in: billIds } }, include: { lines: true } });
  const invoices = await prisma.invoice.findMany({ where: { billId: { in: billIds } }, select: { billId: true, placeOfSupply: true } });
  const buckets = new Map<string, { rate: number; category: string; taxable: number; tax: number; cgst: number; sgst: number; igst: number }>();
  for (const c of collections) {
    const bill = bills.find((x) => x.id === c.billId);
    if (!bill) continue;
    const lines = bill.lines.filter((l) => l.netAmount > 0 && (!l.voidedAt || bill.closedAt));
    const base = lines.reduce((x, l) => x + l.netAmount, 0);
    if (!base) continue;
    const collected = c._sum.amount ?? 0;
    const pos = invoices.find((i) => i.billId === bill.id)?.placeOfSupply ?? s.club.state_code;
    for (const l of lines) {
      const share = roundDiv(collected * l.netAmount, base);
      const tax = roundDiv(share * l.taxRate, 100 + l.taxRate);
      const key = `${l.taxRate}|${l.taxCategory}`;
      const cur = buckets.get(key) ?? { rate: l.taxRate, category: l.taxCategory, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
      const split = splitTax(tax, pos, s.club.state_code);
      cur.taxable += share - tax;
      cur.tax += tax;
      cur.cgst += split.cgst;
      cur.sgst += split.sgst;
      cur.igst += split.igst;
      buckets.set(key, cur);
    }
  }
  // Alcohol is outside GST (state excise): listed separately, never in the GST totals (completion pass §9).
  const all = [...buckets.values()];
  const outside = all.filter((r) => r.category === "OUTSIDE_GST");
  const rows = all.filter((r) => r.category !== "OUTSIDE_GST").sort((x, y) => y.rate - x.rate || x.category.localeCompare(y.category));
  const outsideGst = outside.reduce((t, r) => t + r.taxable + r.tax, 0);
  const totals = rows.reduce((t, r) => ({ taxable: t.taxable + r.taxable, tax: t.tax + r.tax, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst, igst: t.igst + r.igst }), { taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 });
  const inputGst = await prisma.expenseBill.aggregate({ where: { status: "PAID", paidAt: { gte: a, lt: b } }, _sum: { inputGst: true } });
  return { period: p, ratesVerified: verified, rows, totals, outsideGst, inputGst: inputGst._sum.inputGst ?? 0, note: "Report support only — verify rates and figures with your tax advisor before filing." };
}

// ───────────── GSTR-1 support and Tally export (completion pass §9) ─────────────

const fmtGstDate = (d: Date) => {
  const [y, m, day] = istDate(d).split("-");
  return `${day}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`;
};

/**
 * GSTR-1 working tables for a period, by date of supply (invoice issue date / line date): B2B invoices to
 * registered clients (per invoice and rate), B2CS (everything else, per rate and place of supply), the HSN/SAC
 * summary, and non-GST supplies (alcohol). Returns create no credit notes: a return simply lowers the sales.
 */
export async function gstr1(actor: Actor, raw: PeriodInput) {
  assertCan(actor, "gst");
  await assertCapability("gst");
  const p = resolvePeriod(raw);
  const s = await getSettings();
  const [a, b] = bounds(p.from, p.to);
  // GSTR-1 writes the place of supply as "24-Gujarat".
  const stateName = (code: string) => `${code}-${INDIAN_STATES.find((x) => x.code === code)?.name ?? ""}`;
  // B2B: issued invoices to clients with a GSTIN.
  const invoices = await prisma.invoice.findMany({
    where: { number: { not: null }, status: { not: "CANCELLED" }, businessClientId: { not: null }, issueDate: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } },
    orderBy: { number: "asc" },
  });
  const clients = await prisma.businessClient.findMany({ where: { id: { in: invoices.map((i) => i.businessClientId!) } } });
  const b2bBillIds = new Set<string>();
  const b2b: Array<{ gstin: string; name: string; number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }> = [];
  for (const inv of invoices) {
    const c = clients.find((x) => x.id === inv.businessClientId);
    if (!c?.gstin) continue;
    b2bBillIds.add(inv.billId);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: inv.billId }, include: { lines: { where: { voidedAt: null } } } });
    const byRate = new Map<number, { taxable: number; tax: number }>();
    for (const l of bill.lines) {
      if (l.taxCategory === "OUTSIDE_GST") continue;
      const cur = byRate.get(l.taxRate) ?? { taxable: 0, tax: 0 };
      cur.taxable += l.netAmount - l.taxAmount;
      cur.tax += l.taxAmount;
      byRate.set(l.taxRate, cur);
    }
    for (const [rate, v] of [...byRate.entries()].sort((x, y) => x[0] - y[0])) {
      const split = splitTax(v.tax, inv.placeOfSupply, s.club.state_code);
      b2b.push({ gstin: c.gstin, name: c.name, number: inv.number!, date: fmtGstDate(inv.issueDate!), value: bill.total, pos: stateName(inv.placeOfSupply), rate, taxable: v.taxable, ...split });
    }
  }
  // Every other supply in the period (non-void lines on bills that are not B2B invoices).
  const lines = await prisma.billLine.findMany({ where: { voidedAt: null, createdAt: { gte: a, lt: b }, NOT: { billId: { in: [...b2bBillIds] } } } });
  const b2bLines = b2bBillIds.size ? await prisma.billLine.findMany({ where: { voidedAt: null, billId: { in: [...b2bBillIds] } } }) : [];
  const b2cs = new Map<number, { rate: number; pos: string; taxable: number; cgst: number; sgst: number }>();
  let nonGst = 0;
  for (const l of lines) {
    if (l.taxCategory === "OUTSIDE_GST") {
      nonGst += l.netAmount;
      continue;
    }
    const cur = b2cs.get(l.taxRate) ?? { rate: l.taxRate, pos: stateName(s.club.state_code), taxable: 0, cgst: 0, sgst: 0 };
    const split = splitTax(l.taxAmount, s.club.state_code, s.club.state_code);
    cur.taxable += l.netAmount - l.taxAmount;
    cur.cgst += split.cgst;
    cur.sgst += split.sgst;
    b2cs.set(l.taxRate, cur);
  }
  const hsn = new Map<string, { hsn: string; rate: number; qty: number; value: number; taxable: number; tax: number }>();
  for (const l of [...lines, ...b2bLines]) {
    if (l.taxCategory === "OUTSIDE_GST") continue;
    const key = `${l.hsnSac}|${l.taxRate}`;
    const cur = hsn.get(key) ?? { hsn: l.hsnSac, rate: l.taxRate, qty: 0, value: 0, taxable: 0, tax: 0 };
    cur.qty += l.qty;
    cur.value += l.netAmount;
    cur.taxable += l.netAmount - l.taxAmount;
    cur.tax += l.taxAmount;
    hsn.set(key, cur);
  }
  return {
    period: p, gstin: s.club.gstin, b2b,
    b2cs: [...b2cs.values()].sort((x, y) => x.rate - y.rate),
    hsn: [...hsn.values()].sort((x, y) => x.hsn.localeCompare(y.hsn) || x.rate - y.rate),
    nonGst,
    note: "Working tables for GSTR-1 (by date of supply). Check them with your tax advisor before filing.",
  };
}

const TALLY_LEDGER: Record<LedgerSource, string> = {
  COURTS: "Court Fees", SOCIAL: "Social Play Fees", SHOP: "Shop Sales", BAR: "Bar & Cafe Sales", MEMBERSHIP: "Membership Fees",
  INVOICE: "Corporate Invoices", EXPENSE: "Expenses", PAYROLL: "Salaries",
};
const TALLY_CASH_BANK: Record<PaymentMethod, string> = { CASH: "Cash", CARD: "Card Settlements (Bank)", UPI: "UPI Collections (Bank)", BANK_TRANSFER: "Bank Account", ONLINE: "Razorpay Settlements (Bank)" };

/** Day book for Tally import: one row per ledger entry, receipts and payments with their cash/bank ledger. */
export async function tallyRows(actor: Actor, raw: PeriodInput & LedgerListFilter & { source?: string; method?: string }) {
  assertCan(actor, "finance.reports");
  const l = await listLedger(actor, raw);
  return [...l.rows].reverse().map((r) => {
    const receipt = r.amount >= 0 && r.direction === "IN";
    return {
      date: istDate(r.occurredAt).split("-").reverse().join("-"),
      voucherType: receipt ? "Receipt" : "Payment",
      voucherNo: (r.paymentId ?? r.id).slice(-10).toUpperCase(),
      ledger: TALLY_LEDGER[r.source],
      cashBank: TALLY_CASH_BANK[r.method],
      amount: rupees(Math.abs(r.amount)),
      drCr: receipt ? "Cr" : "Dr",
      narration: r.description,
    };
  });
}

// ───────────── ledger explorer & CSV (DB-5) ─────────────

/** Ledger filters as the ledger list (v3 §3.2) sends them: a date preset (or ALL), comma-separated facets, a search. */
export type LedgerListFilter = { range?: DatePreset | "ALL"; direction?: string; q?: string };
const LEDGER_SOURCES: LedgerSource[] = [...INCOME_SOURCES, "EXPENSE", "PAYROLL"];

function oneOf<T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T[] | undefined {
  if (!raw) return undefined;
  const v = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (v.some((x) => !(allowed as readonly string[]).includes(x))) throw new DomainError("VALIDATION_FAILED", `Unknown ${what} "${raw}".`);
  return v.length ? (v as T[]) : undefined;
}

/** The period for the ledger: the old period picker, or the ledger list's date preset (ALL = from the first entry). */
async function ledgerPeriod(raw: PeriodInput & LedgerListFilter): Promise<Period> {
  if (!raw.range) return resolvePeriod(raw);
  const today = istDate(clock.now());
  const r = raw.range === "ALL" ? { from: null, to: null } : resolveRange(raw.range, raw.from ?? null, raw.to ?? null, today);
  let from = r.from;
  if (!from) {
    const first = (await prisma.ledgerEntry.aggregate({ _min: { occurredAt: true } }))._min.occurredAt;
    from = first ? istDate(first) : today;
  }
  const to = r.to ?? (from > today ? from : today);
  return resolvePeriod({ period: "CUSTOM", from, to }, today);
}

export async function listLedger(actor: Actor, raw: PeriodInput & LedgerListFilter & { source?: string; method?: string }) {
  assertCan(actor, "finance.reports");
  const p = await ledgerPeriod(raw);
  const [a, b] = bounds(p.from, p.to);
  const source = oneOf(raw.source, LEDGER_SOURCES, "source");
  const method = oneOf(raw.method, METHODS, "method");
  const direction = oneOf(raw.direction, ["IN", "OUT"] as const, "direction");
  const q = raw.q?.trim();
  const rows = await prisma.ledgerEntry.findMany({
    where: {
      occurredAt: { gte: a, lt: b },
      source: source ? { in: source } : undefined,
      method: method ? { in: method } : undefined,
      direction: direction ? { in: direction } : undefined,
      description: q ? { contains: q, mode: "insensitive" } : undefined,
    },
    orderBy: { occurredAt: "desc" },
    take: 2000,
  });
  return { period: p, rows, total: rows.reduce((x, r) => x + r.amount, 0) };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** CSV export of any report (DB-5). */
export async function exportCsv(actor: Actor, report: string, raw: PeriodInput & LedgerListFilter & { metric?: string; source?: string; method?: string }) {
  if (report === "drilldown") {
    const d = await drillDown(actor, raw.metric ?? "collected", raw);
    return toCsv(["When (IST)", "Source", "Method", "Description", d.kind === "money" ? "Amount (₹)" : "Count"], d.rows.map((r) => [fmtDateTime(r.at), r.source, r.method ?? "", r.description, d.kind === "money" ? rupees(r.amount) : r.amount]));
  }
  if (report === "ledger") {
    const l = await listLedger(actor, raw);
    return toCsv(["When (IST)", "Source", "Direction", "Method", "Description", "Amount (₹)", "Tax (₹)"], l.rows.map((r) => [fmtDateTime(r.occurredAt), r.source, r.direction, r.method, r.description, rupees(r.amount), rupees(r.taxAmount)]));
  }
  if (report === "gst") {
    const g = await gstReport(actor, raw);
    return toCsv(["Rate %", "Category", "Taxable (₹)", "Tax (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)"], [
      ...g.rows.map((r) => [r.rate, r.category, rupees(r.taxable), rupees(r.tax), rupees(r.cgst), rupees(r.sgst), rupees(r.igst)]),
      ["", "TOTAL", rupees(g.totals.taxable), rupees(g.totals.tax), rupees(g.totals.cgst), rupees(g.totals.sgst), rupees(g.totals.igst)],
      ["", "OUTSIDE GST (alcohol, state excise)", rupees(g.outsideGst), "", "", "", ""],
    ]);
  }
  if (report === "gstr1_b2b") {
    const g = await gstr1(actor, raw);
    return toCsv(["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Invoice Type", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax"],
      g.b2b.map((r) => [r.gstin, r.name, r.number, r.date, rupees(r.value), r.pos, "N", "Regular", r.rate, rupees(r.taxable), rupees(r.igst), rupees(r.cgst), rupees(r.sgst)]));
  }
  if (report === "gstr1_b2cs") {
    const g = await gstr1(actor, raw);
    return toCsv(["Type", "Place Of Supply", "Rate", "Taxable Value", "Central Tax", "State/UT Tax"], [
      ...g.b2cs.map((r) => ["OE", r.pos, r.rate, rupees(r.taxable), rupees(r.cgst), rupees(r.sgst)]),
      ["NON-GST", "", "", rupees(g.nonGst), "", ""],
    ]);
  }
  if (report === "gstr1_hsn") {
    const g = await gstr1(actor, raw);
    return toCsv(["HSN/SAC", "Rate", "Total Quantity", "Total Value", "Taxable Value", "Total Tax"], g.hsn.map((r) => [r.hsn, r.rate, r.qty, rupees(r.value), rupees(r.taxable), rupees(r.tax)]));
  }
  if (report === "tally") {
    const rows = await tallyRows(actor, raw);
    return toCsv(["Date", "Voucher Type", "Voucher No", "Ledger", "Cash/Bank Ledger", "Amount", "Dr/Cr", "Narration"], rows.map((r) => [r.date, r.voucherType, r.voucherNo, r.ledger, r.cashBank, r.amount, r.drCr, r.narration]));
  }
  if (report === "dashboard") {
    const d = (await dashboard(actor, raw)) as { period: Period; money: Record<string, unknown> };
    const rows: Array<Array<unknown>> = [];
    const walk = (prefix: string, o: unknown) => {
      if (o && typeof o === "object" && "value" in (o as Record<string, unknown>)) {
        const k = o as { value: number; prev: number; change: number | null };
        rows.push([prefix, rupees(k.value), rupees(k.prev), k.change ?? ""]);
      } else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(prefix ? `${prefix}.${k}` : k, v);
    };
    walk("", d.money);
    return toCsv([`Metric (${d.period.label} ${d.period.from}→${d.period.to})`, "Value (₹)", "Previous (₹)", "Change %"], rows);
  }
  throw new DomainError("VALIDATION_FAILED", `Unknown report ${report}.`);
}

// ───────────── share links (DB-5, E-19) ─────────────

export async function createShareLink(actor: Actor, raw: PeriodInput & { days?: number }) {
  assertCan(actor, "share_links");
  const s = await getSettings();
  const params = periodSchema.parse(raw);
  resolvePeriod(params); // validate now
  return withTx(async (tx) => {
    const token = randomBytes(18).toString("base64url");
    const expiresAt = new Date(clock.now().getTime() + Math.min(raw.days ?? s.share_link_days, 90) * 86_400_000);
    const link = await tx.shareLink.create({ data: { token, reportParams: params as Prisma.InputJsonValue, expiresAt, createdBy: actorId(actor) ?? "system" } });
    await audit(tx, actor, "share_link.create", "share_link", link.id, { after: { params, expiresAt } });
    return { id: link.id, url: `/share/${token}`, expiresAt };
  });
}

export async function revokeShareLink(actor: Actor, id: string) {
  assertCan(actor, "share_links");
  return withTx(async (tx) => {
    const l = await tx.shareLink.findUnique({ where: { id } });
    if (!l) throw new DomainError("NOT_FOUND", "Share link was not found.");
    if (l.revokedAt) return l;
    const updated = await tx.shareLink.update({ where: { id }, data: { revokedAt: clock.now() } });
    await audit(tx, actor, "share_link.revoke", "share_link", id, { after: { revokedAt: updated.revokedAt } });
    return updated;
  });
}

export async function listShareLinks(actor: Actor) {
  assertCan(actor, "share_links");
  const links = await prisma.shareLink.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const now = clock.now().getTime();
  return links.map((l) => ({ ...l, active: !l.revokedAt && l.expiresAt.getTime() > now }));
}

/** Read-only shared report: the owner-level money summary for the saved period, until expiry or revocation. */
export async function getSharedReport(token: string) {
  const l = await prisma.shareLink.findUnique({ where: { token } });
  if (!l) throw new DomainError("NOT_FOUND", "This share link is not valid.");
  if (l.revokedAt) throw new DomainError("FORBIDDEN", "This share link was revoked by the owner.");
  if (l.expiresAt.getTime() < clock.now().getTime()) throw new DomainError("FORBIDDEN", "This share link has expired.");
  const d = await computeDashboard("FINANCE", l.reportParams as PeriodInput);
  const s = await getSettings();
  return { club: s.club.name, expiresAt: l.expiresAt, report: d, summary: `${formatINR((d.money as { collected: { value: number } }).collected.value)} collected` };
}
