// Pricing engine (plan §5.3, E-01). PR-1: only this module computes prices; every module calls it.
// Output per line: unit price, discount %, discount amount, net, tax rate, tax amount and a human explanation.
import type { Plan, Sport } from "@prisma/client";
import { formatINR, inclusiveTax, percentOf } from "@/lib/money";
import { dbDate, fromDbDate } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { DomainError } from "../errors";
import { getSettings, type Settings, type TaxCategory } from "./settings";

export type Tier = "GOLD" | "SILVER" | "JUNIOR" | "WALK_IN";

export type PricedLine = {
  description: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  netAmount: number;
  taxRate: number;
  taxAmount: number;
  taxCategory: TaxCategory;
  hsnSac: string;
  explanation: string;
  variantId?: string | null;
  menuItemId?: string | null;
};

export type Quote = {
  tier: Tier;
  lines: PricedLine[];
  total: number;
  taxTotal: number;
  discountTotal: number;
};

export type Entitlements = {
  tier: Tier;
  planId: string | null;
  membershipId: string | null;
  membershipEnd: string | null;
  courtFee: Record<Sport, number>;
  socialFee: number;
  shopDiscountPct: number;
  barDiscountPct: number;
  advanceBookingDays: number;
  alcoholAllowed: boolean;
};

type Db = Tx | typeof prisma;

const TIER_LABEL: Record<Tier, string> = { GOLD: "Gold member", SILVER: "Silver member", JUNIOR: "Junior member", WALK_IN: "Walk-in" };
export const tierLabel = (t: Tier) => TIER_LABEL[t];

/**
 * PR-3 / MB-4 / MB-10: the member's tier on a date of service is the plan of a paid membership whose
 * [start, end] covers that date; otherwise WALK_IN. Computed from dates and payment, never a stale status.
 */
export async function effectiveMembership(db: Db, memberId: string, date: string) {
  return db.membership.findFirst({
    where: {
      memberId,
      status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] },
      startDate: { lte: dbDate(date) },
      endDate: { gte: dbDate(date) },
    },
    include: { plan: { include: { courtFees: true } } },
    orderBy: { startDate: "desc" },
  });
}

function walkInEntitlements(s: Settings): Entitlements {
  return {
    tier: "WALK_IN",
    planId: null,
    membershipId: null,
    membershipEnd: null,
    courtFee: { ...s.walk_in.court_fee },
    socialFee: s.walk_in.social_fee,
    shopDiscountPct: s.walk_in.shop_discount_pct,
    barDiscountPct: s.walk_in.bar_discount_pct,
    advanceBookingDays: s.walk_in.advance_booking_days,
    alcoholAllowed: true, // guests still need the ID check (BR-5)
  };
}

function planEntitlements(
  plan: Plan & { courtFees: { sport: Sport; fee: number }[] },
  s: Settings,
  membership: { id: string; endDate: Date },
): Entitlements {
  const courtFee = { ...s.walk_in.court_fee };
  for (const f of plan.courtFees) courtFee[f.sport] = f.fee;
  return {
    tier: plan.code,
    planId: plan.id,
    membershipId: membership.id,
    membershipEnd: fromDbDate(membership.endDate),
    courtFee,
    socialFee: plan.socialFee,
    shopDiscountPct: plan.shopDiscountPct,
    barDiscountPct: plan.barDiscountPct,
    advanceBookingDays: plan.advanceBookingDays,
    alcoholAllowed: plan.alcoholAllowed,
  };
}

/** Entitlements of a customer (member or guest/walk-in) for a date of service. */
export async function entitlementsFor(
  db: Db,
  customer: { memberId?: string | null },
  date: string,
  settings?: Settings,
): Promise<Entitlements> {
  const s = settings ?? (await getSettings(db as Tx));
  if (!customer.memberId) return walkInEntitlements(s);
  const m = await effectiveMembership(db, customer.memberId, date);
  if (!m) return walkInEntitlements(s);
  return planEntitlements(m.plan, s, m);
}

/** The single line calculator: discount half-up at line level, GST extracted from the inclusive net (§2). */
export function priceLine(
  input: {
    description: string;
    qty: number;
    unitPrice: number;
    discountPct?: number;
    discountAmount?: number;
    taxCategory: TaxCategory;
    hsnSac: string;
    explanation: string;
    variantId?: string | null;
    menuItemId?: string | null;
  },
  settings: Settings,
): PricedLine {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new DomainError("VALIDATION_FAILED", "Quantity must be a positive whole number.");
  if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0) throw new DomainError("VALIDATION_FAILED", "Price must be a non-negative amount in paise.");
  const gross = input.unitPrice * input.qty;
  const discountPct = input.discountPct ?? 0;
  const discountAmount = Math.min(gross, input.discountAmount ?? percentOf(gross, discountPct));
  const netAmount = gross - discountAmount;
  const taxRate = settings.tax_rates[input.taxCategory];
  return {
    description: input.description,
    qty: input.qty,
    unitPrice: input.unitPrice,
    discountPct,
    discountAmount,
    netAmount,
    taxRate,
    taxAmount: inclusiveTax(netAmount, taxRate),
    taxCategory: input.taxCategory,
    hsnSac: input.hsnSac,
    explanation: input.explanation,
    variantId: input.variantId ?? null,
    menuItemId: input.menuItemId ?? null,
  };
}

export function summarise(tier: Tier, lines: PricedLine[]): Quote {
  return {
    tier,
    lines,
    total: lines.reduce((a, l) => a + l.netAmount, 0),
    taxTotal: lines.reduce((a, l) => a + l.taxAmount, 0),
    discountTotal: lines.reduce((a, l) => a + l.discountAmount, 0),
  };
}

// ───────────── court & social (PR-4) ─────────────

export type PlayerRef = { memberId: string; name: string } | { guestId: string; name: string };

export type PlayerPrice = PricedLine & { tier: Tier; memberId: string | null; guestId: string | null; name: string };

/** PR-4: court fee per player per session, by each player's tier on the session date (mixed groups sum per player). */
export async function quoteCourt(
  db: Db,
  input: { sport: Sport; date: string; courtName: string; timeLabel: string; players: PlayerRef[] },
  settings?: Settings,
): Promise<Quote & { players: PlayerPrice[] }> {
  const s = settings ?? (await getSettings(db as Tx));
  const players: PlayerPrice[] = [];
  for (const p of input.players) {
    const memberId = "memberId" in p ? p.memberId : null;
    const e = await entitlementsFor(db, { memberId }, input.date, s);
    const fee = e.courtFee[input.sport];
    const explanation =
      fee === 0
        ? `${TIER_LABEL[e.tier]} · courts included (₹0)`
        : `${TIER_LABEL[e.tier]} rate · ${formatINR(fee)} per player per hour`;
    const line = priceLine(
      {
        description: `${input.courtName} ${input.timeLabel} — ${p.name}`,
        qty: 1,
        unitPrice: fee,
        taxCategory: "COURT",
        hsnSac: s.sac_codes.COURT,
        explanation,
      },
      s,
    );
    players.push({ ...line, tier: e.tier, memberId, guestId: "guestId" in p ? p.guestId : null, name: p.name });
  }
  const primaryTier = players[0]?.tier ?? "WALK_IN";
  return { ...summarise(primaryTier, players), players };
}

/** SP-3: social play fee = the plan's social_fee (WALK_IN rate for guests). */
export async function quoteSocial(
  db: Db,
  input: { date: string; title: string; player: PlayerRef },
  settings?: Settings,
): Promise<Quote & { player: PlayerPrice }> {
  const s = settings ?? (await getSettings(db as Tx));
  const memberId = "memberId" in input.player ? input.player.memberId : null;
  const e = await entitlementsFor(db, { memberId }, input.date, s);
  const line = priceLine(
    {
      description: `Social play: ${input.title} — ${input.player.name}`,
      qty: 1,
      unitPrice: e.socialFee,
      taxCategory: "COURT",
      hsnSac: s.sac_codes.COURT,
      explanation:
        e.socialFee === 0 ? `${TIER_LABEL[e.tier]} · social play included (₹0)` : `${TIER_LABEL[e.tier]} social fee ${formatINR(e.socialFee)}`,
    },
    s,
  );
  const player: PlayerPrice = {
    ...line,
    tier: e.tier,
    memberId,
    guestId: "guestId" in input.player ? input.player.guestId : null,
    name: input.player.name,
  };
  return { ...summarise(e.tier, [line]), player };
}

// ───────────── shop (PR-5) ─────────────

export type ShopItem = {
  variantId: string;
  qty: number;
  name: string;
  price: number;
  taxCategory: string;
  hsnSac: string;
};

/** PR-5: price × (1 − shop_discount_pct), also for services; delivery fee is never discounted. */
export async function quoteShop(
  db: Db,
  input: { memberId?: string | null; date: string; items: ShopItem[]; deliveryFee?: number },
  settings?: Settings,
): Promise<Quote> {
  const s = settings ?? (await getSettings(db as Tx));
  const e = await entitlementsFor(db, { memberId: input.memberId }, input.date, s);
  const lines = input.items.map((it) =>
    priceLine(
      {
        description: it.name,
        qty: it.qty,
        unitPrice: it.price,
        discountPct: e.shopDiscountPct,
        taxCategory: asTaxCategory(it.taxCategory),
        hsnSac: it.hsnSac,
        explanation: e.shopDiscountPct
          ? `${TIER_LABEL[e.tier]} · ${e.shopDiscountPct}% shop discount`
          : `${TIER_LABEL[e.tier]} · no discount`,
        variantId: it.variantId,
      },
      s,
    ),
  );
  if (input.deliveryFee && input.deliveryFee > 0) {
    lines.push(
      priceLine(
        {
          description: "Delivery",
          qty: 1,
          unitPrice: input.deliveryFee,
          taxCategory: "DELIVERY",
          hsnSac: s.sac_codes.DELIVERY,
          explanation: "Flat delivery fee · never discounted",
        },
        s,
      ),
    );
  }
  return summarise(e.tier, lines);
}

// ───────────── bar (PR-6) ─────────────

export type BarItem = { menuItemId: string; qty: number; name: string; price: number; taxCategory: string; hsnSac: string; note?: string | null };

/** PR-6: menu price × (1 − bar_discount_pct) based on the tab's payer. */
export async function quoteBar(
  db: Db,
  input: { memberId?: string | null; date: string; items: BarItem[] },
  settings?: Settings,
): Promise<Quote> {
  const s = settings ?? (await getSettings(db as Tx));
  const e = await entitlementsFor(db, { memberId: input.memberId }, input.date, s);
  const lines = input.items.map((it) =>
    priceLine(
      {
        description: it.name,
        qty: it.qty,
        unitPrice: it.price,
        discountPct: e.barDiscountPct,
        taxCategory: asTaxCategory(it.taxCategory),
        hsnSac: it.hsnSac,
        explanation: e.barDiscountPct
          ? `${TIER_LABEL[e.tier]} · ${e.barDiscountPct}% bar discount`
          : `${TIER_LABEL[e.tier]} · no discount`,
        menuItemId: it.menuItemId,
      },
      s,
    ),
  );
  return summarise(e.tier, lines);
}

// ───────────── membership ─────────────

/** Membership price for a duration, minus an upgrade credit (MB-7). Price never goes below 0. */
export function quoteMembership(
  input: { plan: { name: string; code: string; price1m: number; price3m: number; price12m: number }; months: number; credit?: number; creditNote?: string; startDate: string; endDate: string },
  settings: Settings,
): Quote {
  const unit = input.months === 1 ? input.plan.price1m : input.months === 3 ? input.plan.price3m : input.months === 12 ? input.plan.price12m : -1;
  if (unit < 0) throw new DomainError("VALIDATION_FAILED", "Membership duration must be 1, 3 or 12 months.");
  const credit = Math.min(unit, Math.max(0, input.credit ?? 0));
  const line = priceLine(
    {
      description: `${input.plan.name} membership · ${input.months} month${input.months > 1 ? "s" : ""} (${input.startDate} → ${input.endDate})`,
      qty: 1,
      unitPrice: unit,
      discountAmount: credit,
      taxCategory: "MEMBERSHIP",
      hsnSac: settings.sac_codes.MEMBERSHIP,
      explanation: credit > 0 ? `${input.plan.name} plan price ${formatINR(unit)} − ${input.creditNote ?? "upgrade credit"} ${formatINR(credit)}` : `${input.plan.name} plan price`,
    },
    settings,
  );
  return summarise(input.plan.code as Tier, [line]);
}

/** Manual / business lines (IN-2): priced as entered, no plan discount. */
export function quoteManual(
  lines: Array<{ description: string; qty: number; unitPrice: number; taxCategory?: TaxCategory; hsnSac?: string }>,
  settings: Settings,
): Quote {
  return summarise(
    "WALK_IN",
    lines.map((l) =>
      priceLine(
        {
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          taxCategory: l.taxCategory ?? "BUSINESS_SERVICE",
          hsnSac: l.hsnSac ?? settings.sac_codes.BUSINESS_SERVICE,
          explanation: "Invoice line as agreed with the client",
        },
        settings,
      ),
    ),
  );
}

export function asTaxCategory(c: string): TaxCategory {
  const known: TaxCategory[] = ["COURT", "MEMBERSHIP", "GOODS", "SERVICE", "RESTAURANT", "ALCOHOL", "DELIVERY", "BUSINESS_SERVICE"];
  if ((known as string[]).includes(c)) return c as TaxCategory;
  throw new DomainError("VALIDATION_FAILED", `Unknown tax category ${c}.`);
}
