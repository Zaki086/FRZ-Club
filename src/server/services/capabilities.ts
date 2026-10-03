// Capability system (completion pass §1): a feature is either real or absent.
// Each capability is computed from env + Owner settings (cached 60 s). Services call assertCapability(); when a
// capability is off they throw CAPABILITY_DISABLED, and the UI does not render the option at all.
import { isValidGstin, isValidUpiVpa } from "@/lib/codes";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { getSettings } from "./settings";

export const CAPABILITY_NAMES = [
  "payments.cash",
  "payments.card",
  "payments.upi",
  "payments.online",
  "email",
  "delivery",
  "gst",
  "photos.upload",
  // v3 §6.3 notification channels.
  "push",
  "whatsapp.api",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilityState = { enabled: boolean; reason: string };
export type Capabilities = Record<CapabilityName, CapabilityState>;

const DISABLED_MESSAGE: Record<CapabilityName, string> = {
  "payments.cash": "Cash payments are not available.",
  "payments.card": "Card payments are not enabled. The Owner can turn on “Card machine available” in Settings.",
  "payments.upi": "UPI payments are not enabled. The Owner must enter and confirm the club's UPI ID in Settings.",
  "payments.online": "Online payments are not available. Please pay at the club.",
  email: "Email is not set up for this club.",
  delivery: "Delivery is not available. Please choose pickup at the club.",
  gst: "GST is not configured for this club.",
  "photos.upload": "Photo upload is not available.",
  push: "Push notifications are not set up for this club.",
  "whatsapp.api": "Automatic WhatsApp messages are not set up for this club.",
};

const isTestEnv = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

// ───────── test overrides (only honoured under NODE_ENV=test) ─────────
let overrides: Partial<Record<CapabilityName, boolean>> = {};
export function setCapabilityOverridesForTests(o: Partial<Record<CapabilityName, boolean>>) {
  if (!isTestEnv()) throw new Error("capability overrides are only available in tests");
  overrides = { ...o };
  invalidateCapabilities();
}

// ───────── Razorpay live verification (once per process, re-checked every 10 minutes) ─────────
let razorpayCheck: { at: number; ok: boolean; reason: string } | null = null;

export function razorpayLiveConfigured(): { ok: boolean; reason: string } {
  const id = process.env.RAZORPAY_KEY_ID ?? "";
  if (!id) return { ok: false, reason: "RAZORPAY_KEY_ID is not set" };
  if (!id.startsWith("rzp_live_")) return { ok: false, reason: "Only live Razorpay keys (rzp_live_…) enable online payments" };
  if (!process.env.RAZORPAY_KEY_SECRET) return { ok: false, reason: "RAZORPAY_KEY_SECRET is not set" };
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return { ok: false, reason: "RAZORPAY_WEBHOOK_SECRET is not set" };
  return { ok: true, reason: "live keys present" };
}

async function verifyRazorpay(): Promise<{ ok: boolean; reason: string }> {
  const cfg = razorpayLiveConfigured();
  if (!cfg.ok) return cfg;
  if (razorpayCheck && Date.now() - razorpayCheck.at < 10 * 60_000) return razorpayCheck;
  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: { Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64") },
      signal: AbortSignal.timeout(8000),
    });
    razorpayCheck = { at: Date.now(), ok: res.ok, reason: res.ok ? "verified with Razorpay" : `Razorpay rejected the keys (HTTP ${res.status})` };
  } catch (e) {
    razorpayCheck = { at: Date.now(), ok: false, reason: `Could not reach Razorpay: ${e instanceof Error ? e.message : String(e)}` };
  }
  return razorpayCheck;
}

/** Web Push needs HTTPS and a VAPID key pair (npx web-push generate-vapid-keys). */
export function pushConfigured(): { ok: boolean; reason: string } {
  if (!(process.env.APP_URL ?? "").startsWith("https://")) return { ok: false, reason: "APP_URL is not HTTPS (browsers only allow push on HTTPS)" };
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return { ok: false, reason: "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set" };
  return { ok: true, reason: "VAPID keys set, HTTPS" };
}

/** WhatsApp Cloud API (Meta): token, phone number id and the app secret that signs delivery webhooks. */
export function whatsappConfigured(): { ok: boolean; reason: string } {
  const missing = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"].filter((k) => !process.env[k]);
  return missing.length ? { ok: false, reason: `${missing.join(", ")} not set` } : { ok: true, reason: "credentials set" };
}

export function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

// ───────── computation + cache ─────────
let cache: { at: number; caps: Capabilities } | null = null;

export function invalidateCapabilities() {
  cache = null;
}

export async function computeCapabilities(): Promise<Capabilities> {
  const s = await getSettings();
  const taxRow = await prisma.setting.findUnique({ where: { key: "tax_rates" } });
  const pm = s.payment_methods;
  const online = isTestEnv() ? { ok: true, reason: "test gateway (tests only)" } : await verifyRazorpay();
  const caps: Capabilities = {
    "payments.cash": { enabled: true, reason: "always available" },
    "payments.card": pm.card_enabled ? { enabled: true, reason: "card machine available" } : { enabled: false, reason: "“Card machine available” is off" },
    "payments.upi": !isValidUpiVpa(pm.upi_vpa)
      ? { enabled: false, reason: "no valid UPI ID entered" }
      : !pm.upi_confirmed
        ? { enabled: false, reason: "the Owner has not confirmed the UPI ID receives club payments" }
        : { enabled: true, reason: `payments go to ${pm.upi_vpa}` },
    "payments.online": { enabled: online.ok, reason: online.reason },
    email: !smtpConfigured()
      ? { enabled: false, reason: "SMTP_HOST / SMTP_FROM are not set" }
      : !s.email_verified_at
        ? { enabled: false, reason: "send a test email from Settings first" }
        : { enabled: true, reason: `verified ${s.email_verified_at}` },
    delivery: !s.delivery.enabled
      ? { enabled: false, reason: "delivery is switched off" }
      : !s.delivery.pincodes.length
        ? { enabled: false, reason: "no serviceable PIN codes" }
        : { enabled: true, reason: `${s.delivery.pincodes.length} PIN code(s)` },
    gst: !isValidGstin(s.club.gstin)
      ? { enabled: false, reason: s.club.gstin ? "the GSTIN is not valid (format or check digit)" : "not GST-registered (no GSTIN)" }
      : !taxRow?.verified
        ? { enabled: false, reason: "tax rates are not confirmed by the Owner" }
        : { enabled: true, reason: `GSTIN ${s.club.gstin}` },
    "photos.upload": { enabled: true, reason: "stored on the server disk" },
    push: (() => {
      const p = pushConfigured();
      return { enabled: p.ok, reason: p.reason };
    })(),
    "whatsapp.api": (() => {
      const w = whatsappConfigured();
      if (!w.ok) return { enabled: false, reason: w.reason };
      if (!Object.keys(s.whatsapp_templates).length) return { enabled: false, reason: "no approved message templates entered in Settings" };
      if (!s.whatsapp_verified_at) return { enabled: false, reason: "send a test message from Settings first" };
      return { enabled: true, reason: `verified ${s.whatsapp_verified_at}` };
    })(),
  };
  for (const [k, v] of Object.entries(overrides) as Array<[CapabilityName, boolean]>) {
    caps[k] = { enabled: v, reason: v ? "enabled (test override)" : "disabled (test override)" };
  }
  return caps;
}

export async function getCapabilities(): Promise<Capabilities> {
  if (cache && Date.now() - cache.at < 60_000) return cache.caps;
  const caps = await computeCapabilities();
  cache = { at: Date.now(), caps };
  return caps;
}

export async function isEnabled(name: CapabilityName): Promise<boolean> {
  return (await getCapabilities())[name].enabled;
}

export async function assertCapability(name: CapabilityName): Promise<void> {
  if (!(await isEnabled(name))) throw new DomainError("CAPABILITY_DISABLED", DISABLED_MESSAGE[name], { capability: name });
}

/** What the UI may render. Disabled options are simply absent. */
export async function publicCapabilities() {
  const c = await getCapabilities();
  const s = await getSettings();
  const methods = (["CASH", "CARD", "UPI"] as const).filter((m) => c[`payments.${m.toLowerCase()}` as CapabilityName].enabled);
  return {
    counterMethods: methods,
    online: c["payments.online"].enabled,
    email: c.email.enabled,
    delivery: c.delivery.enabled ? { fee: s.delivery.fee, pincodes: s.delivery.pincodes } : null,
    gst: c.gst.enabled,
    upiVpa: c["payments.upi"].enabled ? s.payment_methods.upi_vpa : null,
    pushKey: c.push.enabled ? process.env.VAPID_PUBLIC_KEY ?? null : null,
    whatsappApi: c["whatsapp.api"].enabled,
    clubName: s.club.name,
    sampleData: s.instance_mode === "SAMPLE_DATA",
  };
}

/** Owner status page: every capability with the reason it is on or off. */
export async function capabilityStatus(actor: Actor) {
  assertCan(actor, "settings");
  invalidateCapabilities();
  return getCapabilities();
}
