// v4 §5.4 step 3: the one HTTP client for the WhatsApp Cloud API (Meta Graph API). Sends one template message and
// classifies every failure so the queue (PUSH, channels.ts) knows what to do:
//   RETRY        network error, timeout, HTTP 5xx, Meta's transient codes (1, 2, 131000, 131016)
//   RATE_LIMITED HTTP 429 and Meta's throughput / pair / account rate-limit codes → pause for `pauseMs`, keep QUEUED
//   PERMANENT    invalid or non-WhatsApp number, template missing / not approved / paused / disabled, parameter
//                mismatch, policy blocks, bad token, misconfiguration → FAILED at once, no retry (fallback task)
// The access token comes from env only and is never logged, returned or put in an error reason.
import { clock } from "@/lib/clock";

export type WaSendResult =
  | { ok: true; wamid: string }
  | { ok: false; kind: "RETRY"; reason: string }
  | { ok: false; kind: "RATE_LIMITED"; reason: string; pauseMs: number }
  | { ok: false; kind: "PERMANENT"; reason: string; code?: number };

export type WaSendInput = { to: string; template: string; language: string; params: string[]; buttonParam: string | null };

const isTest = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;
let fetcher: typeof fetch | null = null;

/** Tests only: replace the HTTP client used for every Graph API call (sending, token check, template list). */
export function setWhatsAppFetchForTests(f: typeof fetch | null): void {
  if (!isTest()) throw new Error("WhatsApp fetch override is only available in tests");
  fetcher = f;
}

export function graphFetch(): typeof fetch {
  return fetcher ?? fetch;
}

/** The Graph API base for the configured version, or null when the version is not set (no hard-coded default). */
export function graphBase(): string | null {
  const v = (process.env.WHATSAPP_GRAPH_API_VERSION ?? "").trim();
  if (!v) return null;
  return `https://graph.facebook.com/${v.startsWith("v") ? v : `v${v}`}`;
}

/** WA-13: Indian mobile numbers only, in the international format WhatsApp wants (no "+"). */
export const WA_TO_RE = /^91[6-9]\d{9}$/;

// ───────── Meta error codes (WhatsApp Cloud API + Graph API) ─────────
/** Throughput / pair-rate / account rate limits: wait and send again later. Pause per code. */
const RATE_LIMIT_PAUSE_MS: Record<number, number> = {
  4: 5 * 60_000, // API too many calls (app-level)
  80007: 5 * 60_000, // WhatsApp Business Account rate limit
  130429: 60_000, // Cloud API throughput reached
  131048: 15 * 60_000, // spam rate limit hit (number quality)
  131056: 60_000, // (business, consumer) pair rate limit: too many messages to the same person
};
/** Meta says: temporary, try again. */
const TRANSIENT = new Set([1, 2, 131000, 131016]);
/** Never worth another try: number, template, parameter, policy, account or credential problems. */
const PERMANENT = new Set([
  0, 3, 10, 100, 190, 200, 368, // auth, permission, invalid parameter, policy block
  33, // object does not exist (wrong phone number id)
  130472, // number is part of an experiment
  131008, 131009, // parameter missing / invalid
  131021, // recipient cannot be the sender
  131026, // message undeliverable (not on WhatsApp, old app, terms not accepted)
  131030, // recipient not in allowed list (test numbers)
  131031, // business account locked
  131042, // payment / eligibility problem
  131045, // certificate / registration problem
  131047, // re-engagement window
  131049, // not delivered to keep ecosystem engagement healthy
  131050, // user stopped receiving marketing messages
  131051, // unsupported message type
  131052, 131053, // media problems
  132000, // number of parameters does not match the template
  132001, // template does not exist (name / language)
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // parameter format mismatch
  132015, // template paused (low quality)
  132016, // template disabled
  132068, 132069, // flow problems
  133000, 133004, 133005, 133006, 133008, 133009, 133010, // phone number registration problems
]);

type MetaError = { message?: string; type?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; title?: string };

function describe(err: MetaError | undefined, status: number): string {
  const parts = [err?.code != null ? `#${err.code}` : `HTTP ${status}`, err?.title ?? err?.message, err?.error_data?.details].filter(Boolean);
  // Never echo anything that could contain the token (Meta never does, but be safe).
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  let s = parts.join(" ").replace(/\s+/g, " ").trim();
  if (token) s = s.split(token).join("[token]");
  return s.slice(0, 300);
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 24 * 3600_000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - clock.now().getTime(), 24 * 3600_000)) : null;
}

/** WA-12: map an HTTP status + Meta error to RETRY / RATE_LIMITED / PERMANENT. Exported for unit tests. */
export function classifyWhatsAppError(status: number, err: MetaError | undefined, retryAfter: number | null = null): Exclude<WaSendResult, { ok: true }> {
  const code = typeof err?.code === "number" ? err.code : undefined;
  const reason = describe(err, status);
  if (status === 429 || (code != null && code in RATE_LIMIT_PAUSE_MS)) {
    return { ok: false, kind: "RATE_LIMITED", reason, pauseMs: retryAfter ?? (code != null ? RATE_LIMIT_PAUSE_MS[code] : undefined) ?? 60_000 };
  }
  if (code != null && TRANSIENT.has(code)) return { ok: false, kind: "RETRY", reason };
  if (code != null && PERMANENT.has(code)) return { ok: false, kind: "PERMANENT", reason, code };
  if (status >= 500) return { ok: false, kind: "RETRY", reason };
  // Any other 4xx: the request itself is wrong; sending it again cannot help.
  return { ok: false, kind: "PERMANENT", reason, ...(code != null ? { code } : {}) };
}

/** Which env variables the sender needs and are missing (names only). */
export function missingSendEnv(): string[] {
  return ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_API_VERSION"].filter((k) => !(process.env[k] ?? "").trim());
}

/** The request body Meta expects for a template message (exported for tests and the Settings preview). */
export function templateRequestBody(input: WaSendInput) {
  const components: Array<Record<string, unknown>> = [];
  if (input.params.length) components.push({ type: "body", parameters: input.params.map((text) => ({ type: "text", text })) });
  if (input.buttonParam) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: input.buttonParam }] });
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: { name: input.template, language: { code: input.language }, ...(components.length ? { components } : {}) },
  };
}

/** Send one approved template message. Never throws: every outcome is a `WaSendResult`. */
export async function sendTemplateMessage(input: WaSendInput): Promise<WaSendResult> {
  const missing = missingSendEnv();
  if (missing.length) return { ok: false, kind: "PERMANENT", reason: `WhatsApp API is not configured: ${missing.join(", ")} not set` };
  if (!WA_TO_RE.test(input.to)) return { ok: false, kind: "PERMANENT", reason: "Not a valid Indian mobile number for WhatsApp (91XXXXXXXXXX)" };
  if (!/^[a-z0-9_]{1,512}$/.test(input.template)) return { ok: false, kind: "PERMANENT", reason: `Invalid template name "${input.template.slice(0, 60)}"` };
  if (!/^[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$/.test(input.language)) return { ok: false, kind: "PERMANENT", reason: `Invalid language code "${input.language.slice(0, 10)}"` };
  let res: Response;
  try {
    res = await graphFetch()(`${graphBase()}/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID!.trim())}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN!.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(templateRequestBody(input)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, kind: "RETRY", reason: name === "TimeoutError" || name === "AbortError" ? "WhatsApp API did not answer in time" : `Network error: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}` };
  }
  const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: MetaError };
  if (res.ok) {
    const wamid = json.messages?.[0]?.id;
    if (wamid) return { ok: true, wamid };
    return { ok: false, kind: "RETRY", reason: "WhatsApp API answered without a message id" };
  }
  const out = classifyWhatsAppError(res.status, json.error, retryAfterMs(res));
  if (out.kind === "PERMANENT" && (out.code === 190 || res.status === 401)) {
    // The token was revoked or expired: switch the capability off until the Owner checks it again.
    const { markTokenRejected } = await import("./config");
    await markTokenRejected(out.reason).catch(() => undefined);
  }
  return out;
}
