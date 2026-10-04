// v6 WI-5: the signed receipt QR `RC1.<billId>.<hmac>` printed on counter-sale receipts (HMAC-SHA256 with APP_SECRET
// over `RC1.<billId>`, base64url — the same construction as the v4 refund QR). An anonymous walk-in sale has no person
// on it, so the receipt is how it is found again: the desk scans this QR (or types the receipt code) to find the sale
// and to pay out a refund on it. It carries no personal data; verification is constant-time.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "RC1";
const MAC_LENGTH = 32;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(billId: string): string {
  return createHmac("sha256", secret()).update(`${PREFIX}.${billId}`).digest("base64url").slice(0, MAC_LENGTH);
}

/** The receipt QR value for a bill. */
export function receiptToken(billId: string): string {
  return `${PREFIX}.${billId}.${mac(billId)}`;
}

/** The bill id when the token is authentic, otherwise null (wrong shape, other prefix, forged mac). */
export function verifyReceiptToken(token: string): string | null {
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

/** True when scanned text looks like a receipt QR (so a scanner can route it). */
export function isReceiptToken(text: string): boolean {
  return String(text ?? "").trim().startsWith(`${PREFIX}.`);
}
