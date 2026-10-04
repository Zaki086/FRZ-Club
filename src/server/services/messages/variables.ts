// v5 §3.1: template variables (MT-1) and the text renderer. Pure functions — no database — so they are unit-tested.
//
// Each context exposes only its own variables plus `club.*`, `portal.url` and `{{link}}` (the record's deep link).
// `member.first_name` is the greeting name of the record's person in every person context (MEMBER, BOOKING, REFUND,
// ORDER, TAB, INVOICE); the other `member.*`, `membership.*` and `dues.*` variables are MEMBER-only; LEAD greets with
// `lead.first_name`; GENERAL (announcements) has no personal variables at all.
import { FILL_IN_RE, TEMPLATE_CONTEXTS, type TemplateContext, type VariableInfo } from "./contract";

const PERSON: TemplateContext[] = ["MEMBER", "BOOKING", "REFUND", "ORDER", "TAB", "INVOICE"];
const ALL = TEMPLATE_CONTEXTS as readonly TemplateContext[];

/** Every variable: what it shows, a format hint, and the contexts that have it. */
export const VARIABLES: Record<string, { label: string; example: string; contexts: readonly TemplateContext[] }> = {
  "member.first_name": { label: "First name of the person", example: "first word of the name on the record", contexts: PERSON },
  "member.code": { label: "Member code", example: "the member's code, as on the card", contexts: ["MEMBER"] },
  "membership.plan": { label: "Membership plan", example: "plan name, e.g. Gold", contexts: ["MEMBER"] },
  "membership.end_date": { label: "Membership end date", example: "date, e.g. 12 Oct 2026", contexts: ["MEMBER"] },
  "dues.amount": { label: "Amount due (all unpaid bills)", example: "amount, e.g. ₹1,550", contexts: ["MEMBER"] },
  "booking.code": { label: "Booking code", example: "the booking's code", contexts: ["BOOKING"] },
  "booking.court": { label: "Court", example: "court name", contexts: ["BOOKING"] },
  "booking.date": { label: "Booking date", example: "day and date, e.g. Sat, 3 Oct 2026", contexts: ["BOOKING"] },
  "booking.time": { label: "Booking time", example: "start–end, e.g. 6:00 pm–7:00 pm", contexts: ["BOOKING"] },
  "refund.code": { label: "Refund reference", example: "the refund's code", contexts: ["REFUND"] },
  "refund.amount": { label: "Refund amount", example: "amount, e.g. ₹550", contexts: ["REFUND"] },
  "order.code": { label: "Order / restring ticket code", example: "the order's or ticket's code", contexts: ["ORDER"] },
  "tab.total": { label: "Bar tab to settle", example: "amount still to pay on the tab", contexts: ["TAB"] },
  "lead.first_name": { label: "Lead's first name", example: "first word of the lead's name", contexts: ["LEAD"] },
  "invoice.number": { label: "Invoice number", example: "the invoice number", contexts: ["INVOICE"] },
  "invoice.due_date": { label: "Invoice due date", example: "date, e.g. 12 Oct 2026", contexts: ["INVOICE"] },
  "club.name": { label: "Club name", example: "from Settings → Club details", contexts: ALL },
  "club.phone": { label: "Club phone", example: "from Settings → Club details", contexts: ALL },
  "club.address": { label: "Club address", example: "from Settings → Club details", contexts: ALL },
  "portal.url": { label: "Member portal address", example: "the portal's web address", contexts: ALL },
  link: { label: "Link to this record", example: "booking, refund, order, tab, invoice or quote page", contexts: ALL },
};

/** The variables a context may use (MT-1). */
export function variablesForContext(context: TemplateContext): VariableInfo[] {
  return Object.entries(VARIABLES)
    .filter(([, v]) => v.contexts.includes(context))
    .map(([name, v]) => ({ name, label: v.label, example: v.example }));
}

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every `{{variable}}` in a text (names as written, trimmed). */
export function extractVariables(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1]);
}

/**
 * MT-1: variables the context doesn't have, plus any broken `{{`/`}}` (an unclosed brace would be sent as is).
 * Empty array = valid.
 */
export function unknownVariables(context: TemplateContext, texts: string[]): string[] {
  const allowed = new Set(variablesForContext(context).map((v) => v.name));
  const bad = new Set<string>();
  for (const t of texts) {
    for (const name of extractVariables(t)) if (!allowed.has(name)) bad.add(`{{${name}}}`);
    const rest = t.replace(TOKEN, "");
    const broken = /\{\{[^}]*\}{0,2}|\}\}/.exec(rest);
    if (broken) bad.add(broken[0].slice(0, 40));
  }
  return [...bad];
}

export type RenderValues = Record<string, string>;

/**
 * Fill the variables in. A line whose variables all came out empty (no club phone yet, no link for this record) is
 * left out instead of being sent half-written; blank lines never pile up. Values are inserted as plain text — HTML
 * escaping happens when the email is built (render.ts).
 */
export function renderText(text: string, values: RenderValues): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const names = extractVariables(line);
    if (names.length && names.every((n) => !(values[n] ?? "").trim())) continue;
    out.push(line.replace(TOKEN, (_, n: string) => values[n] ?? ""));
  }
  return out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A `[[…]]` part staff still have to write (the send is refused while one remains). */
export function hasFillIn(text: string): boolean {
  return FILL_IN_RE.test(text);
}

// ───────── automatic WhatsApp (v4 §5 Meta templates) a message template may map to ─────────

/** Meta templates whose values can be filled from a record of the given context. */
export const AUTO_WHATSAPP = {
  membership_expiring: { context: "MEMBER", label: "Membership expiring (membership_expiring)" },
  dues_reminder: { context: "MEMBER", label: "Dues reminder (dues_reminder)" },
  membership_welcome: { context: "MEMBER", label: "Welcome (membership_welcome)" },
  booking_rescheduled: { context: "BOOKING", label: "Booking rescheduled (booking_rescheduled)" },
  refund_ready_to_collect: { context: "REFUND", label: "Refund ready to collect (refund_ready_to_collect)" },
  refund_completed: { context: "REFUND", label: "Refund completed (refund_completed)" },
} as const satisfies Record<string, { context: TemplateContext; label: string }>;
export type AutoWhatsAppTemplate = keyof typeof AUTO_WHATSAPP;

export function isAutoWhatsAppTemplate(name: string | null | undefined): name is AutoWhatsAppTemplate {
  return !!name && Object.prototype.hasOwnProperty.call(AUTO_WHATSAPP, name);
}

// ───────── masking (MT-6: recipients are shown masked in the log and the composer) ─────────

/** "+91 ••••••3210" */
export function maskPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 4) return null;
  return `+91 ••••••${d.slice(-4)}`;
}

/** "ra•••@gmail.com" */
export function maskEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  return `${e.slice(0, Math.min(2, at))}•••${e.slice(at)}`;
}

/** The wa.me link a manual WhatsApp opens: `https://wa.me/91XXXXXXXXXX?text=<URL-encoded text>`. */
export function waMeLink(number91: string, text: string): string {
  return `https://wa.me/${number91}?text=${encodeURIComponent(text)}`;
}
