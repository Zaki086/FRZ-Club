// v4 RF-8: the signed refund collection QR / link token `RF1.<refundId>.<hmac>` (HMAC-SHA256 with APP_SECRET over
// `RF1.<refundId>`, base64url). The same value is the QR the member shows at the desk, the `/rq/<token>` page path
// and the WhatsApp "Show QR" button suffix. It carries no personal data and never expires (refunds never expire,
// RF-10); what it may show is decided by the refund's current state. Verification is constant-time.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "RF1";
const MAC_LENGTH = 32;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(refundId: string): string {
  return createHmac("sha256", secret()).update(`${PREFIX}.${refundId}`).digest("base64url").slice(0, MAC_LENGTH);
}

/** The collection QR value / `/rq/` token for a refund request. */
export function refundCollectToken(refundId: string): string {
  return `${PREFIX}.${refundId}.${mac(refundId)}`;
}

/** The refund request id when the token is authentic, otherwise null (wrong shape, other prefix, forged mac). */
export function verifyRefundCollectToken(token: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(String(token ?? ""));
  } catch {
    return null;
  }
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1])) return null;
  const expected = Buffer.from(mac(parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return parts[1];
}

/** True when the scanned text looks like a refund QR (so the desk scanner can route it). */
export function isRefundCollectToken(text: string): boolean {
  return String(text ?? "").trim().startsWith(`${PREFIX}.`);
}
