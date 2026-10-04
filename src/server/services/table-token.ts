// v5 MN-6: the signed bar-table token printed as a QR on each table card: `TBL1.<tableId>.<hmac>` (HMAC-SHA256 with
// APP_SECRET over `TBL1.<tableId>`, base64url, first 32 chars). The QR encodes `<APP_URL>/t/<token>`; the `/t/<token>`
// route (MO-1) stores the verified table on the member's session. The token carries no personal data and never
// expires (a reprinted card is the same card); whether the table still exists is the caller's check. Verification is
// constant-time.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "TBL1";
const MAC_LENGTH = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(tableId: string): string {
  return createHmac("sha256", secret()).update(`${PREFIX}.${tableId}`).digest("base64url").slice(0, MAC_LENGTH);
}

/** The table card token for a bar table id (`TBL1.<tableId>.<hmac>`). */
export function signTableToken(tableId: string): string {
  if (!ID_RE.test(tableId)) throw new Error("Invalid table id");
  return `${PREFIX}.${tableId}.${mac(tableId)}`;
}

/** `{ tableId }` when the token is authentic, otherwise null (wrong shape, other prefix, forged or altered mac). */
export function verifyTableToken(token: string): { tableId: string } | null {
  let text: string;
  try {
    text = decodeURIComponent(String(token ?? "")).trim();
  } catch {
    return null;
  }
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !ID_RE.test(parts[1])) return null;
  const expected = Buffer.from(mac(parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { tableId: parts[1] };
}

/** The URL a table card's QR encodes: `<APP_URL>/t/<token>`. */
export function tableCardUrl(tableId: string): string {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return `${base}/t/${signTableToken(tableId)}`;
}
