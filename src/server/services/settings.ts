// Settings (plan §2 "no magic numbers", §11.1). Every business number lives here or in the plan tables,
// is editable by the Owner, and is seeded with these defaults.
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Sport } from "@prisma/client";
import { clock } from "@/lib/clock";
import { isValidGstin } from "@/lib/codes";
import { prisma, withTx, type Tx } from "../db";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { DomainError } from "../errors";
import { audit } from "./audit";

const sportFees = z.object({
  TENNIS: z.number().int().min(0),
  CRICKET: z.number().int().min(0),
  PADEL: z.number().int().min(0),
  BADMINTON: z.number().int().min(0),
});

export const SETTINGS_SCHEMA = {
  opening_hours: z.object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/) }),
  max_plays_per_day: z.number().int().min(1).max(10),
  cancel_full_refund_hours: z.number().min(0).max(72),
  staff_grace_minutes: z.number().int().min(0).max(60),
  checkin_window_before_minutes: z.number().int().min(0).max(240),
  walk_in: z.object({
    court_fee: sportFees,
    social_fee: z.number().int().min(0),
    shop_discount_pct: z.number().int().min(0).max(100),
    bar_discount_pct: z.number().int().min(0).max(100),
    advance_booking_days: z.number().int().min(0).max(60),
  }),
  social_default_capacity: z.number().int().min(1).max(100),
  trial_fee: z.number().int().min(0),
  // §1 capability inputs (Owner-configured; nothing is enabled by default)
  payment_methods: z.object({
    card_enabled: z.boolean(),
    upi_vpa: z.string().max(256),
    upi_confirmed: z.boolean(),
  }),
  delivery: z.object({
    enabled: z.boolean(),
    pincodes: z.array(z.string().regex(/^[1-9][0-9]{5}$/, "PIN codes are 6 digits")).max(200),
    fee: z.number().int().min(0),
  }),
  email_verified_at: z.string().nullable(),
  instance_mode: z.enum(["NORMAL", "SAMPLE_DATA"]),
  setup_completed_at: z.string().nullable(),
  last_backup: z.object({ at: z.string(), file: z.string(), bytes: z.number().int(), ok: z.boolean().default(true), error: z.string().nullable().default(null) }).nullable(),
  online_hold_minutes: z.number().int().min(1).max(1440),
  pickup_hold_hours: z.number().int().min(1).max(720),
  default_reorder_level: z.number().int().min(0),
  public_low_stock_threshold: z.number().int().min(0),
  restring_turnaround_hours: z.number().int().min(1).max(240),
  leave_allowance: z.object({ CASUAL: z.number().int().min(0), SICK: z.number().int().min(0) }),
  // v3 §4.3 attendance rules AT-2, AT-3, AT-4.
  late_grace_minutes: z.number().int().min(0).max(120),
  // v3 RF-3: a Manager approves refunds up to this amount (paise); above it, the Owner.
  refund_manager_limit: z.number().int().min(0),
  // v3 §6.4 WK-2: how long a one-time set-password link works.
  credential_link_hours: z.number().int().min(1).max(720),
  // v3 §7.2 CC-4/CC-6 club cancellations; §8.2 LA-8 lead escalation.
  reschedule_window_days: z.number().int().min(1).max(60),
  // v3 §9.2 PR-11 / §9.3 guardrails (Owner only): promotions above these need approval.
  max_manager_discount_pct: z.number().int().min(0).max(100),
  max_staff_discount_pct: z.number().int().min(0).max(100),
  resolution_deadline_days: z.number().int().min(1).max(60),
  lead_escalation_hours: z.number().int().min(1).max(720),
  // v3 §6.5 NT-2: first dues reminder after this many days unpaid (then weekly, at most 3).
  dues_reminder_days: z.number().int().min(1).max(60),
  // v3 §6.3: approved WhatsApp Cloud API templates per event, and when a test message last succeeded.
  whatsapp_templates: z.record(z.string(), z.object({ name: z.string().trim().min(1).max(100), language: z.string().trim().min(2).max(10) })),
  whatsapp_verified_at: z.string().nullable(),
  overtime_threshold_minutes: z.number().int().min(0).max(600),
  missing_clockout_hours: z.number().int().min(1).max(48),
  invoice_terms_days: z.number().int().min(0).max(365),
  lead_follow_up_hours: z.number().int().min(1).max(720),
  quote_valid_days: z.number().int().min(1).max(90),
  share_link_days: z.number().int().min(1).max(90),
  expiring_soon_days: z.number().int().min(1).max(60),
  club: z.object({
    name: z.string().max(120),
    legal_name: z.string().max(160),
    address: z.string().max(400),
    state: z.string().max(60),
    state_code: z.string().regex(/^(\d{2})?$/, "State code is 2 digits"),
    gstin: z.string().max(15),
    phone: z.string().max(20),
    email: z.string().max(160),
    logo_url: z.string().max(300),
  }),
  tax_rates: z.object({
    COURT: z.number().int().min(0).max(40),
    MEMBERSHIP: z.number().int().min(0).max(40),
    GOODS_5: z.number().int().min(0).max(40),
    GOODS_18: z.number().int().min(0).max(40),
    SERVICE: z.number().int().min(0).max(40),
    RESTAURANT: z.number().int().min(0).max(40),
    // Alcohol for human consumption is outside GST (state excise/VAT, not modelled); always 0 and listed separately.
    OUTSIDE_GST: z.literal(0),
    DELIVERY: z.number().int().min(0).max(40),
    BUSINESS_SERVICE: z.number().int().min(0).max(40),
  }),
  sac_codes: z.object({
    COURT: z.string(),
    MEMBERSHIP: z.string(),
    DELIVERY: z.string(),
    BUSINESS_SERVICE: z.string(),
  }),
  dev_clock_offset_ms: z.number().int(),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type StoredSettings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };
/** Settings as services see them: stored values plus derived flags. */
export type Settings = StoredSettings & {
  /** §1 `gst` capability: a valid GSTIN (format + check digit) and tax rates confirmed by the Owner. */
  gstEnabled: boolean;
};
export type TaxCategory = keyof StoredSettings["tax_rates"];

const R = (rupees: number) => rupees * 100;

/** §11.1 defaults. */
export const DEFAULT_SETTINGS: StoredSettings = {
  opening_hours: { open: "06:00", close: "22:00" },
  max_plays_per_day: 2,
  cancel_full_refund_hours: 2,
  staff_grace_minutes: 15,
  checkin_window_before_minutes: 30,
  walk_in: {
    court_fee: { TENNIS: R(400), CRICKET: R(400), PADEL: R(400), BADMINTON: R(400) },
    social_fee: R(250),
    shop_discount_pct: 0,
    bar_discount_pct: 0,
    advance_booking_days: 1,
  },
  social_default_capacity: 12,
  trial_fee: 0,
  payment_methods: { card_enabled: false, upi_vpa: "", upi_confirmed: false },
  delivery: { enabled: false, pincodes: [], fee: R(99) },
  email_verified_at: null,
  instance_mode: "NORMAL",
  setup_completed_at: null,
  last_backup: null,
  online_hold_minutes: 15,
  pickup_hold_hours: 48,
  default_reorder_level: 3,
  public_low_stock_threshold: 5,
  restring_turnaround_hours: 24,
  leave_allowance: { CASUAL: 12, SICK: 6 },
  late_grace_minutes: 10,
  refund_manager_limit: R(5000),
  credential_link_hours: 72,
  reschedule_window_days: 14,
  max_manager_discount_pct: 30,
  max_staff_discount_pct: 15,
  resolution_deadline_days: 7,
  lead_escalation_hours: 48,
  dues_reminder_days: 3,
  whatsapp_templates: {},
  whatsapp_verified_at: null,
  overtime_threshold_minutes: 30,
  missing_clockout_hours: 4,
  invoice_terms_days: 15,
  lead_follow_up_hours: 24,
  quote_valid_days: 7,
  share_link_days: 7,
  expiring_soon_days: 7,
  // No made-up identity: the Owner fills these in the setup wizard (§4). The club is in Gujarat per plan.md.
  // Completion pass §4: a fresh install has no identity until the Owner enters it in the setup wizard.
  club: { name: "", legal_name: "", address: "", state: "", state_code: "", gstin: "", phone: "", email: "", logo_url: "" },
  // Placeholders — verified=false until the Owner confirms current GST rates (IN-6, §11.1, §9.2).
  tax_rates: {
    COURT: 18,
    MEMBERSHIP: 18,
    GOODS_5: 5,
    GOODS_18: 18,
    SERVICE: 18,
    RESTAURANT: 5,
    OUTSIDE_GST: 0,
    DELIVERY: 18,
    BUSINESS_SERVICE: 18,
  },
  sac_codes: { COURT: "999652", MEMBERSHIP: "999652", DELIVERY: "996812", BUSINESS_SERVICE: "999652" },
  dev_clock_offset_ms: 0,
};

const UNVERIFIED_BY_DEFAULT: SettingKey[] = ["tax_rates"];

/** Insert any missing settings with their defaults. Idempotent. */
export async function ensureDefaultSettings(outer?: Tx): Promise<void> {
  await withTx(async (tx) => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
      await tx.setting.upsert({
        where: { key },
        create: {
          key,
          value: DEFAULT_SETTINGS[key] as Prisma.InputJsonValue,
          verified: !UNVERIFIED_BY_DEFAULT.includes(key),
        },
        update: {},
      });
    }
  }, outer);
}

/** All settings, validated, with defaults filling any gap. */
export async function getSettings(tx?: Tx): Promise<Settings> {
  const db = tx ?? prisma;
  const rows = await db.setting.findMany();
  const out = { ...DEFAULT_SETTINGS } as Record<SettingKey, unknown>;
  for (const row of rows) {
    const key = row.key as SettingKey;
    const schema = SETTINGS_SCHEMA[key];
    if (!schema) continue;
    const parsed = schema.safeParse(row.value);
    if (parsed.success) out[key] = parsed.data;
  }
  const stored = out as StoredSettings;
  const taxVerified = rows.find((r) => r.key === "tax_rates")?.verified ?? false;
  return { ...stored, gstEnabled: taxVerified && isValidGstin(stored.club.gstin) };
}

export async function getSettingRows(actor: Actor) {
  assertCan(actor, "settings");
  return prisma.setting.findMany({ orderBy: { key: "asc" } });
}

export async function updateSetting(actor: Actor, key: string, value: unknown, opts: { verified?: boolean } = {}) {
  assertCan(actor, "settings");
  if (!(key in SETTINGS_SCHEMA)) throw new DomainError("VALIDATION_FAILED", `Unknown setting "${key}".`);
  const k = key as SettingKey;
  const parsed = SETTINGS_SCHEMA[k].safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", `Invalid value for ${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`, {
      issues: parsed.error.issues,
    });
  }
  return withTx(async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    const row = await tx.setting.upsert({
      where: { key },
      create: { key, value: parsed.data as Prisma.InputJsonValue, verified: opts.verified ?? true },
      update: { value: parsed.data as Prisma.InputJsonValue, verified: opts.verified ?? before?.verified ?? true },
    });
    await audit(tx, actor, "settings.update", "setting", key, { before: before?.value, after: row.value });
    if (k === "walk_in") {
      // v3 §9.2: walk-in court and social fees live in the price book — a change here is a new version from now.
      const v = parsed.data as StoredSettings["walk_in"];
      const now = clock.now();
      const fees: Array<[string, number]> = [...Object.entries(v.court_fee).map(([sport, fee]) => [`COURT_FEE:WALK_IN:${sport}`, fee] as [string, number]), ["SOCIAL_FEE:WALK_IN", v.social_fee]];
      for (const [target, price] of fees) {
        const cur = await tx.priceChange.findFirst({ where: { target, cancelledAt: null, effectiveAt: { lte: now } }, orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }] });
        if (cur?.price !== price) await tx.priceChange.create({ data: { target, price, effectiveAt: now, note: "Walk-in rates in Settings", createdBy: actor.kind === "USER" ? actor.userId : null } });
      }
    }
    const { invalidateCapabilities } = await import("./capabilities");
    invalidateCapabilities();
    return row;
  });
}

export async function verifySetting(actor: Actor, key: string) {
  assertCan(actor, "settings");
  return withTx(async (tx) => {
    const row = await tx.setting.update({ where: { key }, data: { verified: true } });
    await audit(tx, actor, "settings.verify", "setting", key, { after: { verified: true } });
    const { invalidateCapabilities } = await import("./capabilities");
    invalidateCapabilities();
    return row;
  });
}

// ───────── dev clock offset (E-25) ─────────

/** Settings written by the system itself (setup wizard steps, test email, backups) — same validation and audit. */
export async function writeSettingTx(tx: Tx, actor: Actor, key: SettingKey, value: unknown, verified = true) {
  const parsed = SETTINGS_SCHEMA[key].safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED", `Invalid value for ${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const before = await tx.setting.findUnique({ where: { key } });
  await tx.setting.upsert({
    where: { key },
    create: { key, value: parsed.data as Prisma.InputJsonValue, verified },
    update: { value: parsed.data as Prisma.InputJsonValue, verified },
  });
  await audit(tx, actor, "settings.update", "setting", key, { before: before?.value, after: parsed.data });
  const { invalidateCapabilities } = await import("./capabilities");
  invalidateCapabilities();
}

let lastSync = 0;
/** Refresh the in-memory clock offset from settings (cached 2 s). Never used when the clock is pinned. */
export async function syncClockOffset(force = false): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (clock.isFixed()) return;
  const t = Date.now();
  if (!force && t - lastSync < 2000) return;
  lastSync = t;
  const row = await prisma.setting.findUnique({ where: { key: "dev_clock_offset_ms" } });
  const v = row ? Number(row.value) : 0;
  clock.setOffset(Number.isFinite(v) ? v : 0);
}

export function courtFeeFor(fees: Settings["walk_in"]["court_fee"], sport: Sport): number {
  return fees[sport];
}
