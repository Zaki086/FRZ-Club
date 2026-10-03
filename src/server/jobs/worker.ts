// `npm run worker` — node-cron wiring for the jobs in jobs/index.ts (times in Asia/Kolkata).
import cron from "node-cron";
import { syncClockOffset } from "../services/settings";
import { runBackup } from "../services/backups";
import { runDailyJobs, runFrequentJobs, seedInProgress } from "./index";

async function guarded(name: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
    if (await seedInProgress()) {
      console.log(`[worker] ${name} skipped: a seed is rebuilding the database`);
      return;
    }
    await syncClockOffset(true);
    const r = await fn();
    console.log(`[worker] ${name} ok in ${Date.now() - started} ms`, JSON.stringify(r));
  } catch (e) {
    // Logged loudly and retried on the next tick; jobs are idempotent.
    console.error(`[worker] ${name} FAILED`, e);
  }
}

cron.schedule("*/5 * * * *", () => void guarded("every-5-minutes", runFrequentJobs), { timezone: "Asia/Kolkata" });
cron.schedule("5 0 * * *", () => void guarded("daily-00:05", runDailyJobs), { timezone: "Asia/Kolkata" });
// Completion pass 8.6: nightly database backup (kept 14 days). Real time; not part of runDailyJobs, so tests and
// the seed never run pg_dump.
cron.schedule("30 2 * * *", () => void guarded("backup-02:30", () => runBackup("nightly")), { timezone: "Asia/Kolkata" });

console.log("[worker] started: every 5 minutes (no-shows, holds, leads, payments, email), daily 00:05 IST (memberships, invoices, low stock) and the 02:30 IST backup.");
void guarded("startup catch-up", async () => ({ frequent: await runFrequentJobs(), daily: await runDailyJobs() }));
