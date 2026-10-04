// v5 §2 — one contact validation module for client forms AND server Zod schemas (the server is authoritative).
//
// CV-1 mobilePhone: Indian mobile. Accepts spaces, dashes, dots, brackets and a leading +91, 91 or 0. Stored as the
//      canonical form already used in the database: exactly 10 digits, first digit 6–9 (e.g. "9811000001").
// CV-2 rejects all-same digits (9999999999) and obvious running sequences (9876543210, 6789012345). Those are allowed
//      only through the test-only allowlist (CV-7), never in a browser form.
// CV-3 contactPhone: an Indian mobile (CV-1/CV-2) or a landline — STD code + number = 10 digits after removing a
//      leading 0, first digit 2–5. Stored as the 10 digits; shown with formatPhone().
// CV-4 email: trimmed + lower-cased, ≤ 254 characters, dot-atom local part, a dotted domain with a ≥ 2-letter TLD.
// CV-5 loginIdentifier: a valid mobile or a valid email, decided by format ("@" → email).
// CV-7 test-only allowlist: active only on the server under Vitest / NODE_ENV=test, or when the seed sets
//      CONTACTS_TEST_ALLOWLIST=1 for its own process. Never in the browser, never in a production server.
import { z } from "zod";

export const MOBILE_MESSAGE = "Enter a valid 10-digit Indian mobile number.";
export const CONTACT_PHONE_MESSAGE = "Enter a valid Indian phone number with STD code.";
export const EMAIL_MESSAGE = "Enter a valid email address.";
export const LOGIN_IDENTIFIER_MESSAGE = "Enter your registered mobile number or email.";

export const CONTACT_MESSAGES = {
  mobile: MOBILE_MESSAGE,
  contact: CONTACT_PHONE_MESSAGE,
  email: EMAIL_MESSAGE,
  login: LOGIN_IDENTIFIER_MESSAGE,
} as const;

export const EMAIL_MAX_LENGTH = 254;

/**
 * CV-7: numbers the sample data and the test-suite fixtures use that the production rules reject (a running
 * sequence or all-same digits). Accepted only while `isTestAllowlistActive()`.
 */
export const TEST_ONLY_PHONES: readonly string[] = ["9876543210", "9999999999"];

function env(): Record<string, string | undefined> | null {
  if (typeof process === "undefined" || !process.env) return null;
  return process.env;
}

/** CV-7: true only on the server while running tests (Vitest, NODE_ENV=test) or the demo seed (CONTACTS_TEST_ALLOWLIST=1). */
export function isTestAllowlistActive(): boolean {
  if (typeof window !== "undefined") return false;
  const e = env();
  if (!e) return false;
  return e.VITEST === "true" || e.NODE_ENV === "test" || e.CONTACTS_TEST_ALLOWLIST === "1";
}

/** Digits of a phone typed with spaces, dashes, dots, brackets and an optional leading "+"; null for anything else. */
function phoneDigits(raw: string): { digits: string; plus: boolean } | null {
  const s = raw.trim();
  if (!s || s.length > 25) return null;
  // An optional "+" may follow an opening bracket: "(+91) 98110 00001".
  if (!/^[(\s]*\+?[\d\s\-().]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  return digits ? { digits, plus: s.replace(/^[(\s]+/, "").startsWith("+") } : null;
}

/** Remove a leading +91 / 91 (12 digits) or 0 (11 digits). A "+" must be followed by 91. */
function nationalNumber(raw: string): string | null {
  const p = phoneDigits(raw);
  if (!p) return null;
  const d = p.digits;
  if (p.plus) return d.length === 12 && d.startsWith("91") ? d.slice(2) : null;
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return null;
}

/** CV-2: all digits the same, or every step +1 / −1 (wrapping 9→0), e.g. 9876543210, 6789012345, 2345678901. */
export function isObviousFakeNumber(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return true;
  let up = true;
  let down = true;
  for (let i = 1; i < d.length; i++) {
    const step = (Number(d[i]) - Number(d[i - 1]) + 10) % 10;
    if (step !== 1) up = false;
    if (step !== 9) down = false;
  }
  return up || down;
}

function passesFakeCheck(d: string): boolean {
  if (!isObviousFakeNumber(d)) return true;
  return isTestAllowlistActive() && TEST_ONLY_PHONES.includes(d);
}

/** CV-1/CV-2: the canonical 10-digit mobile, or null when the input is not a valid Indian mobile. */
export function normaliseMobile(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const d = nationalNumber(s);
  if (!d || !/^[6-9]\d{9}$/.test(d)) return null;
  return passesFakeCheck(d) ? d : null;
}

/** CV-3: canonical 10 digits for a mobile or an STD landline (first digit 2–5), or null. */
export function normaliseContactPhone(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const d = nationalNumber(s);
  if (!d) return null;
  if (/^[6-9]\d{9}$/.test(d)) return passesFakeCheck(d) ? d : null;
  if (/^[2-5]\d{9}$/.test(d)) return isObviousFakeNumber(d) ? null : d;
  return null;
}

// Dot-atom local part (no leading/trailing/consecutive dots) and LDH domain labels; TLD ≥ 2 letters.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** CV-4: the trimmed, lower-cased email, or null when it is not a valid address. */
export function normaliseEmail(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  if (!v || v.length > EMAIL_MAX_LENGTH) return null;
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) return null;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1]) ? v : null;
}

export type LoginIdentifier = { kind: "mobile"; value: string } | { kind: "email"; value: string };

/** CV-5: decides mobile vs email by format ("@" → email) and normalises; null when neither is valid. */
export function classifyLoginIdentifier(s: string | null | undefined): LoginIdentifier | null {
  if (typeof s !== "string") return null;
  if (s.includes("@")) {
    const e = normaliseEmail(s);
    return e ? { kind: "email", value: e } : null;
  }
  const m = normaliseMobile(s);
  return m ? { kind: "mobile", value: m } : null;
}

/** Display form: "+91 98110 00001" for mobiles; "+91 22 2345 6789" (metro STD) or "+91 124 4567890" for landlines. */
export function formatPhone(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const d = nationalNumber(s);
  if (!d || d.length !== 10) return s.trim();
  if (/^[6-9]/.test(d)) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  // Landline: the 2-digit metro STD codes (Pune 20, Mumbai 22, Kolkata 33, Hyderabad 40, Chennai 44); otherwise 3 + 7.
  if (/^(20|22|33|40|44)/.test(d)) return `+91 ${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  return `+91 ${d.slice(0, 3)} ${d.slice(3)}`;
}

function normalising(fn: (s: string) => string | null, message: string) {
  return z.string({ error: message }).transform((v, ctx) => {
    const out = fn(v);
    if (out === null) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return out;
  });
}

/** CV-1/CV-2 Zod schema: string in, canonical 10-digit mobile out. */
export const mobilePhone = normalising(normaliseMobile, MOBILE_MESSAGE);
/** CV-3 Zod schema: string in, canonical 10 digits out (mobile or STD landline). */
export const contactPhone = normalising(normaliseContactPhone, CONTACT_PHONE_MESSAGE);
/** CV-4 Zod schema: string in, trimmed lower-case email out. */
export const email = normalising(normaliseEmail, EMAIL_MESSAGE);
/** CV-5 Zod schema: string in, the normalised mobile or email out (use classifyLoginIdentifier for the kind). */
export const loginIdentifier = normalising((s) => classifyLoginIdentifier(s)?.value ?? null, LOGIN_IDENTIFIER_MESSAGE);

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Optional field: missing, null or blank → undefined; anything else must pass `schema`. */
export function optionalContact<S extends z.ZodType<string, string>>(schema: S) {
  return z.preprocess((v) => (isBlank(v) ? undefined : v), schema.optional());
}

/** Editable field: missing → undefined (unchanged); null or blank → null (cleared); anything else must pass `schema`. */
export function clearableContact<S extends z.ZodType<string, string>>(schema: S) {
  return z.preprocess((v) => (v === undefined ? undefined : isBlank(v) ? null : v), schema.nullable().optional());
}
