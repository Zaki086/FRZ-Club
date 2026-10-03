// `npm run worker` — node-cron wiring for the jobs in jobs/index.ts (times in Asia/Kolkata).
import cron from "node-cron";
import { syncClockOffset } from "../services/settings";
import { runDailyJobs, runFrequentJobs } from "./index";

async function guarded(name: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
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

console.log("[worker] started: every 5 minutes (no-shows, holds, leads, payments, email) and daily 00:05 IST (memberships, invoices, low stock).");
void guarded("startup catch-up", async () => ({ frequent: await runFrequentJobs(), daily: await runDailyJobs() }));
