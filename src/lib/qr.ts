// Member card QR (MB-14): payload `CC1.<memberId>.<hmac>`. Server-only (uses the app secret).
import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(memberId: string): string {
  return createHmac("sha256", secret()).update(`CC1.${memberId}`).digest("base64url").slice(0, 22);
}

export function memberCardPayload(memberId: string): string {
  return `CC1.${memberId}.${mac(memberId)}`;
}

/** Returns the member id when the payload is authentic, otherwise null. */
export function verifyMemberCardPayload(payload: string): string | null {
  const parts = payload.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "CC1" || !parts[1]) return null;
  const expected = Buffer.from(mac(parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return parts[1];
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: "M" });
}

export { upiLink } from "./upi";
