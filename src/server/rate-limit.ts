// In-house rate limiting (completion pass §6, §9): a fixed-window counter per key, in memory. The app runs as one
// `next start` process (PM2 fork mode), so one process sees every request; a restart simply clears the counters.
import { DomainError } from "./errors";

type Window = { start: number; count: number };
const buckets = new Map<string, Window>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of buckets) if (now - w.start > 3_600_000) buckets.delete(k);
}

/** Count one hit for `key`; throws RATE_LIMITED (429) once `limit` hits fall inside `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number, message = "Too many attempts. Please wait a moment and try again.") {
  const now = Date.now();
  sweep(now);
  const w = buckets.get(key);
  if (!w || now - w.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return;
  }
  w.count++;
  if (w.count > limit) {
    const retryAfter = Math.ceil((w.start + windowMs - now) / 1000);
    throw new DomainError("RATE_LIMITED", message, { retryAfterSeconds: retryAfter });
  }
}

/** Tests only. */
export function resetRateLimits() {
  buckets.clear();
}

/** Best-effort client address (behind a proxy, the first X-Forwarded-For hop). */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}
