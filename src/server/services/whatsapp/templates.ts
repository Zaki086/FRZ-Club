// v4 §5.2: the WhatsApp Cloud API templates the club submits in WhatsApp Manager (category UTILITY, English) and one
// typed builder per template. Meta rejects variable values with newlines, tabs or more than 4 consecutive spaces, so
// every value is sanitised and capped at 60 characters. A URL button carries only the dynamic suffix that WhatsApp
// appends to `https://<APP_URL host>/` (e.g. `r/<token>`).

export const WA_VALUE_MAX = 60;

/** One template variable value as Meta accepts it. */
export function sanitizeTemplateValue(value: string | number): string {
  const s = String(value)
    .replace(/[\r\n\t\f\v]+/g, " ")
    .replace(/ {5,}/g, " ")
    .trim();
  return s.length > WA_VALUE_MAX ? `${s.slice(0, WA_VALUE_MAX - 1).trimEnd()}…` : s;
}

/** Every template: whether automatic sending needs it (v4 §5: cancellations, reschedules, refunds), its body
 *  variables in `{{n}}` order and its URL button (suffix pattern), if any. */
export const WA_TEMPLATES = {
  club_session_cancelled: { required: true, vars: ["name", "session", "date", "time", "reason", "amount", "deadline"], button: "r/{{1}}" },
  booking_cancelled_refund: { required: true, vars: ["name", "booking", "date", "time", "refund"], button: "portal/refunds?ref={{1}}" },
  booking_rescheduled: { required: true, vars: ["name", "court", "time", "date", "booking"], button: "portal/bookings/{{1}}" },
  cancellation_choice_reminder: { required: true, vars: ["name", "date", "deadline", "amount"], button: "r/{{1}}" },
  refund_ready_to_collect: { required: true, vars: ["name", "amount", "ref"], button: "rq/{{1}}" },
  refund_completed: { required: true, vars: ["name", "amount", "date", "ref"], button: null },
  refund_rejected: { required: true, vars: ["name", "ref", "amount", "reason"], button: null },
  refund_unclaimed_reminder: { required: true, vars: ["name", "amount", "ref"], button: "rq/{{1}}" },
  membership_welcome: { required: false, vars: ["name", "plan", "memberCode", "end"], button: null },
  membership_expiring: { required: false, vars: ["name", "plan", "end"], button: null },
  dues_reminder: { required: false, vars: ["name", "amount", "whatFor"], button: null },
} as const;

export type WaTemplateName = keyof typeof WA_TEMPLATES;
/** Every template name, in the order above (for enums and the Settings mapping table). */
export const WA_TEMPLATE_NAMES = Object.keys(WA_TEMPLATES) as [WaTemplateName, ...WaTemplateName[]];
type Val = string | number;

/** What an event hands to `notifyMember({ …, wa })`: the template and its typed values. Amounts are rupees as
 *  shown after "₹" in the template (e.g. "550"), dates and times already formatted for India. */
export type WaMessage =
  | { template: "club_session_cancelled"; vars: { name: Val; session: Val; date: Val; time: Val; reason: Val; amount: Val; deadline: Val }; button: { token: string } }
  | { template: "booking_cancelled_refund"; vars: { name: Val; booking: Val; date: Val; time: Val; refund: Val }; button: { ref: string } }
  | { template: "booking_rescheduled"; vars: { name: Val; court: Val; time: Val; date: Val; booking: Val }; button: { booking: string } }
  | { template: "cancellation_choice_reminder"; vars: { name: Val; date: Val; deadline: Val; amount: Val }; button: { token: string } }
  | { template: "refund_ready_to_collect"; vars: { name: Val; amount: Val; ref: Val }; button: { token: string } }
  | { template: "refund_completed"; vars: { name: Val; amount: Val; date: Val; ref: Val } }
  | { template: "refund_rejected"; vars: { name: Val; ref: Val; amount: Val; reason: Val } }
  | { template: "refund_unclaimed_reminder"; vars: { name: Val; amount: Val; ref: Val }; button: { token: string } }
  | { template: "membership_welcome"; vars: { name: Val; plan: Val; memberCode: Val; end: Val } }
  | { template: "membership_expiring"; vars: { name: Val; plan: Val; end: Val } }
  | { template: "dues_reminder"; vars: { name: Val; amount: Val; whatFor: Val } };

export type BuiltTemplate = { template: WaTemplateName; params: string[]; buttonParam: string | null };

/** The body parameters in `{{n}}` order and the URL button suffix value, all sanitised. */
export function buildTemplate(m: WaMessage): BuiltTemplate {
  const def = WA_TEMPLATES[m.template];
  const vars = m.vars as Record<string, Val>;
  const params = def.vars.map((k) => sanitizeTemplateValue(vars[k] ?? ""));
  const button = "button" in m ? (Object.values(m.button)[0] as string) : null;
  // The button value is a URL path segment: keep it to URL-safe characters (tokens, codes, query values).
  const buttonParam = def.button && button ? encodeURIComponent(String(button)).slice(0, 200) : null;
  return { template: m.template, params, buttonParam };
}

// ───────── values as India reads them (used by every event that passes `wa`) ─────────
const IST = "Asia/Kolkata";
const plainSpaces = (s: string) => s.replace(/[  ]/g, " ");

function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), day: get("day"), month: get("month"), year: get("year") };
}

/** "Sat, 3 Oct 2026" (IST). */
export function waDate(d: Date): string {
  const p = istParts(d);
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

/** "6:00 pm" (IST). */
export function waTime(d: Date): string {
  return plainSpaces(new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }).format(d)).toLowerCase();
}

/** "Sat, 3 Oct, 6:00 pm" (IST) — deadlines. */
export function waDateTime(d: Date): string {
  const p = istParts(d);
  return `${p.weekday}, ${p.day} ${p.month}, ${waTime(d)}`;
}

/** Paise → rupees as written after "₹" in a template: "1,550" or "550.50" (no "₹"). */
export function waAmount(paise: number): string {
  const abs = Math.abs(Math.round(paise));
  const whole = new Intl.NumberFormat("en-IN").format(Math.floor(abs / 100));
  const frac = abs % 100;
  return `${paise < 0 ? "-" : ""}${whole}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}

/** First name for "Hi {{1}}". */
export function waFirstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

/** "Tennis (Court 1)" — the {{2}} session of club_session_cancelled. */
export function waSession(sport: string | null | undefined, court: string): string {
  const s = (sport ?? "").toLowerCase();
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)} (${court})` : court;
}
