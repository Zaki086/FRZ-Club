// `npm run worker` — node-cron wiring for the jobs in jobs/index.ts (times in Asia/Kolkata).
import cron from "node-cron";
import { syncClockOffset } from "../services/settings";
import { runBackup } from "../services/backups";
import { settleAfterCommit } from "../db";
import { flushDeliveries, sweepWhatsApp } from "../services/channels";
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

/** Like `guarded`, but only logs when something was sent or failed (it runs every minute). */
async function quiet(name: string, fn: () => Promise<{ sent: number; failed: number }>) {
  try {
    if (await seedInProgress()) return;
    await syncClockOffset();
    const r = await fn();
    if (r.sent || r.failed) console.log(`[worker] ${name}`, JSON.stringify(r));
  } catch (e) {
    console.error(`[worker] ${name} FAILED`, e);
  }
}

cron.schedule("*/5 * * * *", () => void guarded("every-5-minutes", runFrequentJobs), { timezone: "Asia/Kolkata" });
// Member messages (email, push, WhatsApp API) go out within a minute, independent of the other jobs: a failing job in
// the 5-minute batch can't hold them back. Rows are claimed before sending, so overlapping runs never send twice.
cron.schedule("* * * * *", () => void quiet("deliveries", flushDeliveries), { timezone: "Asia/Kolkata" });
// v4 §5.4: WhatsApp API messages are sent right after their transaction commits; this sweep (every 30 s) sends any
// QUEUED row that is due (after a crash, a retry backoff or a rate-limit pause). Rows are claimed with SKIP LOCKED.
cron.schedule("*/30 * * * * *", () => void quiet("whatsapp", async () => {
  const r = await sweepWhatsApp();
  await settleAfterCommit();
  return r;
}), { timezone: "Asia/Kolkata" });
cron.schedule("5 0 * * *", () => void guarded("daily-00:05", runDailyJobs), { timezone: "Asia/Kolkata" });
// Completion pass 8.6: nightly database backup (kept 14 days). Real time; not part of runDailyJobs, so tests and
// the seed never run pg_dump.
cron.schedule("30 2 * * *", () => void guarded("backup-02:30", () => runBackup("nightly")), { timezone: "Asia/Kolkata" });

console.log("[worker] started: WhatsApp sweep every 30 s; member messages every minute; every 5 minutes (no-shows, holds, leads, payments, email), daily 00:05 IST (memberships, invoices, low stock) and the 02:30 IST backup.");
void guarded("startup catch-up", async () => ({ frequent: await runFrequentJobs(), daily: await runDailyJobs() }));
