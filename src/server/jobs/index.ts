// Scheduled jobs (plan §5.17). Each job is an exported, idempotent function using the injectable clock, so
// tests, the seed and the dev-only "Run all jobs now" button can run them. node-cron wiring is in worker.ts.
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { istDate } from "@/lib/time";
import { prisma, withTx } from "../db";
import { markNoShowsAndCompletions } from "../services/booking";
import { flagOverdueLeads } from "../services/crm";
import { markOverdueInvoices } from "../services/invoices";
import { runMembershipJob } from "../services/membership";
import { flushEmailOutbox, notify } from "../services/notifications";
import { failStalePendingPayments } from "../services/payments";
import { expireHolds } from "../services/shop";
import { getSettings } from "../services/settings";

/** Every 5 minutes: no-shows/completions (BK-9/10), order holds (SH-5), overdue leads (CR-4), stale gateway payments. */
export async function runFrequentJobs() {
  const s = await getSettings();
  return {
    bookings: await markNoShowsAndCompletions(),
    holds: await expireHolds(),
    leads: await flagOverdueLeads(),
    stalePayments: await failStalePendingPayments(Math.max(30, s.online_hold_minutes * 2)),
    emails: await flushEmailOutbox(),
  };
}

/** SH-8 digest: one daily summary of everything at or below its reorder level. */
export async function lowStockDigest() {
  return withTx(async (tx) => {
    const rows = await tx.$queryRaw<{ name: string; label: string; available: number; reorder_level: number }[]>`
      SELECT p.name, v.label, (v.on_hand - v.reserved)::int AS available, v.reorder_level FROM product_variants v
        JOIN products p ON p.id = v.product_id
       WHERE p.track_stock AND p.archived_at IS NULL AND v.archived_at IS NULL AND v.on_hand - v.reserved <= v.reorder_level
       ORDER BY 3`;
    if (rows.length) {
      await notify(tx, {
        roles: ["SHOP_STAFF", "MANAGER", "OWNER"], type: "LOW_STOCK_DIGEST", title: `${rows.length} item${rows.length > 1 ? "s" : ""} at or below reorder level`,
        body: rows.slice(0, 12).map((r) => `${r.name}${r.label !== "Standard" ? ` (${r.label})` : ""}: ${r.available}`).join(" · "),
        link: "/app/shop/stock?filter=low", dedupeKey: `low-stock-digest:${istDate(clock.now())}`,
      });
    }
    return { lowItems: rows.length };
  });
}

/** Daily at 00:05 IST: membership transitions + reminders (MB-4, MB-11), invoice overdue flags, low-stock digest. */
export async function runDailyJobs() {
  const overdueExpenses = await prisma.expenseBill.findMany({ where: { status: "UNPAID", dueDate: { lt: new Date(`${istDate(clock.now())}T00:00:00Z`) } } });
  if (overdueExpenses.length) {
    await withTx((tx) =>
      notify(tx, {
        roles: ["ACCOUNTANT", "OWNER"], type: "EXPENSE_OVERDUE", title: `${overdueExpenses.length} supplier bill${overdueExpenses.length > 1 ? "s are" : " is"} overdue`,
        body: overdueExpenses.slice(0, 8).map((e) => `${e.vendor} ${formatINR(e.amount)}`).join(" · "),
        link: "/app/finance/expenses?status=OVERDUE", dedupeKey: `expense-overdue:${istDate(clock.now())}`,
      }),
    );
  }
  return {
    memberships: await runMembershipJob(),
    invoices: await markOverdueInvoices(),
    lowStock: await lowStockDigest(),
    overdueExpenses: overdueExpenses.length,
  };
}

export async function runAllJobs() {
  return { frequent: await runFrequentJobs(), daily: await runDailyJobs(), at: clock.now().toISOString() };
}

/** Advisory-lock key held by `seed:demo` while it rebuilds the history with its own clock. */
export const SEED_LOCK_KEY = 7310;

/** True while a seed run holds the lock: the worker must not run real-clock jobs on half-built sample data. */
export async function seedInProgress(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ held: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${SEED_LOCK_KEY} AND objsubid = 1 AND granted) AS held`;
  return rows[0]?.held ?? false;
}
