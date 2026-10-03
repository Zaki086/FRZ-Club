// Settings (plan §2 "no magic numbers", §11.1). Every business number lives here or in the plan tables,
// is editable by the Owner, and is seeded with these defaults.
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Sport } from "@prisma/client";
import { clock } from "@/lib/clock";
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
  delivery_fee: z.number().int().min(0),
  online_hold_minutes: z.number().int().min(1).max(1440),
  pickup_hold_hours: z.number().int().min(1).max(720),
  default_reorder_level: z.number().int().min(0),
  public_low_stock_threshold: z.number().int().min(0),
  restring_turnaround_hours: z.number().int().min(1).max(240),
  leave_allowance: z.object({ CASUAL: z.number().int().min(0), SICK: z.number().int().min(0) }),
  invoice_terms_days: z.number().int().min(0).max(365),
  lead_follow_up_hours: z.number().int().min(1).max(720),
  quote_valid_days: z.number().int().min(1).max(90),
  share_link_days: z.number().int().min(1).max(90),
  expiring_soon_days: z.number().int().min(1).max(60),
  club: z.object({
    name: z.string(),
    legal_name: z.string(),
    address: z.string(),
    state: z.string(),
    state_code: z.string().regex(/^\d{2}$/),
    gstin: z.string(),
    phone: z.string(),
    email: z.string(),
    upi_vpa: z.string(),
  }),
  tax_rates: z.object({
    COURT: z.number().int().min(0).max(40),
    MEMBERSHIP: z.number().int().min(0).max(40),
    GOODS: z.number().int().min(0).max(40),
    SERVICE: z.number().int().min(0).max(40),
    RESTAURANT: z.number().int().min(0).max(40),
    ALCOHOL: z.number().int().min(0).max(40),
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
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };
export type TaxCategory = keyof Settings["tax_rates"];

const R = (rupees: number) => rupees * 100;

/** §11.1 defaults. */
export const DEFAULT_SETTINGS: Settings = {
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
  delivery_fee: R(99),
  online_hold_minutes: 15,
  pickup_hold_hours: 48,
  default_reorder_level: 3,
  public_low_stock_threshold: 5,
  restring_turnaround_hours: 24,
  leave_allowance: { CASUAL: 12, SICK: 6 },
  invoice_terms_days: 15,
  lead_follow_up_hours: 24,
  quote_valid_days: 7,
  share_link_days: 7,
  expiring_soon_days: 7,
  club: {
    name: "The Champions Club",
    legal_name: "Champions Sports Club Pvt Ltd",
    address: "12 Riverside Sports Complex, Ahmedabad, Gujarat 380015",
    state: "Gujarat",
    state_code: "24",
    gstin: "24AABCC1234F1Z5",
    phone: "+91 79 4000 1234",
    email: "desk@championsclub.test",
    upi_vpa: "championsclub@testupi",
  },
  // Placeholders — verified=false until the Owner confirms current GST rates (IN-6, §11.1).
  tax_rates: {
    COURT: 18,
    MEMBERSHIP: 18,
    GOODS: 12,
    SERVICE: 18,
    RESTAURANT: 5,
    ALCOHOL: 0,
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
  return out as Settings;
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
    return row;
  });
}

export async function verifySetting(actor: Actor, key: string) {
  assertCan(actor, "settings");
  return withTx(async (tx) => {
    const row = await tx.setting.update({ where: { key }, data: { verified: true } });
    await audit(tx, actor, "settings.verify", "setting", key, { after: { verified: true } });
    return row;
  });
}

// ───────── dev clock offset (E-25) ─────────

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
