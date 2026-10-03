// v4 §5.3: signed links that work without a login (the WhatsApp "Choose option" button opens `/r/<token>`).
// Token: `R1.<clubCancellationId>.<expiry, unix seconds base36>.<hmac>` — HMAC-SHA256 with APP_SECRET over the first
// three parts. The token itself carries no personal data; single use is enforced by the resolution state of the club
// cancellation row (once resolved, the page shows the outcome only).
import { createHmac, timingSafeEqual } from "node:crypto";
import { clock } from "@/lib/clock";

const PREFIX = "R1";

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(body: string): string {
  return createHmac("sha256", secret()).update(`resolution:${body}`).digest("base64url").slice(0, 32);
}

/** WA-20: a resolution link for one club-cancelled booking, valid until `expiresAt` (the resolution deadline). */
export function signResolutionToken(clubCancellationId: string, expiresAt: Date): string {
  if (!/^[A-Za-z0-9_-]+$/.test(clubCancellationId)) throw new Error("invalid id for a resolution token");
  const body = `${PREFIX}.${clubCancellationId}.${Math.floor(expiresAt.getTime() / 1000).toString(36)}`;
  return `${body}.${mac(body)}`;
}

/** Decode + check without the expiry (used to tell "expired" apart from "forged"). */
export function inspectResolutionToken(token: string): { clubCancellationId: string; expiresAt: Date } | null {
  const parts = (token ?? "").trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[0-9a-z]+$/.test(parts[2])) return null;
  const expected = Buffer.from(mac(parts.slice(0, 3).join(".")));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const seconds = parseInt(parts[2], 36);
  if (!Number.isFinite(seconds)) return null;
  return { clubCancellationId: parts[1], expiresAt: new Date(seconds * 1000) };
}

/** The club cancellation id when the token is authentic and not expired; otherwise null. */
export function verifyResolutionToken(token: string): { clubCancellationId: string } | null {
  const t = inspectResolutionToken(token);
  if (!t || t.expiresAt.getTime() <= clock.now().getTime()) return null;
  return { clubCancellationId: t.clubCancellationId };
}
