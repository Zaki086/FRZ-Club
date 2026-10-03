// v4 §5.1: is automatic WhatsApp on, which approved template does an event use, the recipient's number and consent.
// Contract (PUSH's queue calls these): whatsappReady, templateFor, toWhatsAppNumber, whatsappOptedIn.
import { clock } from "@/lib/clock";
import { withTx, type Tx } from "../../db";
import { SYSTEM } from "../../rbac/actor";
import { getCapabilities, whatsappConfigured } from "../capabilities";
import { getSettings, writeSettingTx, type StoredSettings } from "../settings";
import type { WaTemplateName } from "./templates";

/** Every env variable the WhatsApp Cloud API setup needs (values never leave the server). */
export const WHATSAPP_ENV = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "WHATSAPP_GRAPH_API_VERSION",
] as const;

export type WhatsappHealth = StoredSettings["whatsapp_health"];

/** WA-14: capability `whatsapp.api` (env present + token check passed + test message succeeded). */
export async function whatsappReady(db?: Tx): Promise<boolean> {
  void db; // capabilities are read through their 60-second cache (and the test overrides)
  return (await getCapabilities())["whatsapp.api"].enabled;
}

/**
 * WA-15: the template an event uses: mapped by the Owner (name + language) — `approved` only when Meta's last known
 * status for it is APPROVED. Not mapped → null (the event uses the other channels and the manual queue).
 */
export async function templateFor(db: Tx, name: WaTemplateName): Promise<{ name: string; language: string; approved: boolean } | null> {
  const map = (await getSettings(db)).whatsapp_template_map;
  const t = map[name];
  if (!t) return null;
  return { name: t.name, language: t.language, approved: t.status === "APPROVED" };
}

/** Indian mobile number → `91XXXXXXXXXX` (WhatsApp's international format without "+"), else null. */
export function toWhatsAppNumber(phone: string): string | null {
  // Same rule as the manual wa.me links (messages.ts waNumber): 10 digits starting 6–9, with or without 0 / 91 / +91.
  const digits = (phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

/** Opted in = consent given and not withdrawn by a later "STOP". */
export function isOptedIn(r: { whatsappOptInAt: Date | null; whatsappOptOutAt: Date | null } | null | undefined): boolean {
  if (!r?.whatsappOptInAt) return false;
  return !r.whatsappOptOutAt || r.whatsappOptInAt.getTime() > r.whatsappOptOutAt.getTime();
}

/**
 * WA-30: did this person agree to automatic WhatsApp updates? A login is the member it belongs to (a guardian is a
 * member too, so messages about a Junior follow the guardian's own consent); a guest is the guest row.
 * No consent recorded → false: nothing is sent automatically.
 */
export async function whatsappOptedIn(db: Tx, r: { userId?: string | null; guestId?: string | null }): Promise<boolean> {
  if (r.userId) {
    const m = await db.member.findUnique({ where: { userId: r.userId }, select: { whatsappOptInAt: true, whatsappOptOutAt: true } });
    return isOptedIn(m);
  }
  if (r.guestId) {
    const g = await db.guest.findUnique({ where: { id: r.guestId }, select: { whatsappOptInAt: true, whatsappOptOutAt: true } });
    return isOptedIn(g);
  }
  return false;
}

/** The value written when a form's WhatsApp box is ticked (null when it is not). */
export function optInStamp(ticked: boolean | null | undefined): Date | null {
  return ticked ? clock.now() : null;
}

/** Which WhatsApp env variables are set (names only — never values). */
export function whatsappEnvStatus(): { ok: boolean; missing: string[] } {
  const missing = WHATSAPP_ENV.filter((k) => !(process.env[k] ?? "").trim());
  return { ok: missing.length === 0 && whatsappConfigured().ok, missing };
}

/** Update the connection checks shown in Settings (system write, audited). */
export async function writeHealth(patch: Partial<WhatsappHealth>, outer?: Tx): Promise<WhatsappHealth> {
  return withTx(async (tx) => {
    const cur = (await getSettings(tx)).whatsapp_health;
    const next = { ...cur, ...patch };
    await writeSettingTx(tx, SYSTEM, "whatsapp_health", next);
    return next;
  }, outer);
}

/** Meta rejected the access token while sending (code 190 / HTTP 401): the capability goes off until re-checked. */
export async function markTokenRejected(reason: string): Promise<void> {
  await writeHealth({ token_ok: false, token_checked_at: clock.now().toISOString(), token_reason: reason.slice(0, 300) });
}
