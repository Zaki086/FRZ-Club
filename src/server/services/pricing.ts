// Pricing engine (plan §5.3, E-01). PR-1: only this module computes prices; every module calls it.
// Output per line: unit price, discount %, discount amount, net, tax rate, tax amount and a human explanation.
import type { Plan, Sport } from "@prisma/client";
import { formatINR, inclusiveTax, percentOf } from "@/lib/money";
import { clock } from "@/lib/clock";
import { dbDate, fromDbDate, istTime } from "@/lib/time";
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
const clockNow = () => clock.now();
/** IST minute of the day (for time windows such as a happy hour). */
export const istMinute = (d: Date) => { const [h, m] = istTime(d).split(":").map(Number); return h * 60 + m; };

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
  // §1 gst capability: without a valid GSTIN and confirmed rates the club issues plain receipts — no tax at all.
  const taxRate = settings.gstEnabled ? settings.tax_rates[input.taxCategory] : 0;
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

/**
 * PR-4: court fee per player per session, by each player's tier on the session date (mixed groups sum per player).
 * v3 PR-10: the base fee comes from the price book; a special date or else a time band adjusts it; the best single
 * promotion discounts it. With no rules in effect the result is exactly the plan/walk-in fee, as before.
 */
export async function quoteCourt(
  db: Db,
  input: { sport: Sport; date: string; courtName: string; timeLabel: string; players: PlayerRef[]; courtId?: string; startMinute?: number | null; at?: Date },
  settings?: Settings,
): Promise<Quote & { players: PlayerPrice[] }> {
  const s = settings ?? (await getSettings(db as Tx));
  // `at`: the moment rules and prices are taken from (the price simulator); otherwise now.
  const now = input.at ?? clockNow();
  const rules = await rulesInEffect(db, now, "COURTS");
  const players: PlayerPrice[] = [];
  for (const p of input.players) {
    const memberId = "memberId" in p ? p.memberId : null;
    const e = await entitlementsFor(db, { memberId }, input.date, s);
    const base = await bookPrice(db, `COURT_FEE:${e.tier}:${input.sport}`, now, e.courtFee[input.sport]);
    const t: RuleTarget = { scope: "COURTS", date: input.date, minute: input.startMinute ?? null, tier: e.tier, sport: input.sport, courtId: input.courtId ?? null };
    const adj = adjustBase(rules, t, base);
    const disc = adj.price > 0 ? bestDiscount(rules, t, adj.price, 1, null) : null;
    const explanation = !adj.note && !disc
      ? (base === 0 ? `${TIER_LABEL[e.tier]} · courts included (₹0)` : `${TIER_LABEL[e.tier]} rate · ${formatINR(base)} per player per hour`)
      : [`${TIER_LABEL[e.tier]} ${formatINR(base)}`, adj.note, disc?.words].filter(Boolean).join(" · ");
    const line = priceLine(
      {
        description: `${input.courtName} ${input.timeLabel} — ${p.name}`,
        qty: 1,
        unitPrice: adj.price,
        discountPct: disc?.pct ?? 0,
        discountAmount: disc?.amount,
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

/** SP-3: social play fee = the tier's social fee from the price book (WALK_IN rate for guests), then PR-10 rules. */
export async function quoteSocial(
  db: Db,
  input: { date: string; title: string; player: PlayerRef; startMinute?: number | null; at?: Date },
  settings?: Settings,
): Promise<Quote & { player: PlayerPrice }> {
  const s = settings ?? (await getSettings(db as Tx));
  // `at`: the moment rules and prices are taken from (the price simulator); otherwise now.
  const now = input.at ?? clockNow();
  const memberId = "memberId" in input.player ? input.player.memberId : null;
  const e = await entitlementsFor(db, { memberId }, input.date, s);
  const base = await bookPrice(db, `SOCIAL_FEE:${e.tier}`, now, e.socialFee);
  const rules = await rulesInEffect(db, now, "SOCIAL");
  const t: RuleTarget = { scope: "SOCIAL", date: input.date, minute: input.startMinute ?? null, tier: e.tier };
  const adj = adjustBase(rules, t, base);
  const disc = adj.price > 0 ? bestDiscount(rules, t, adj.price, 1, null) : null;
  const explanation = !adj.note && !disc
    ? (base === 0 ? `${TIER_LABEL[e.tier]} · social play included (₹0)` : `${TIER_LABEL[e.tier]} social fee ${formatINR(base)}`)
    : [`${TIER_LABEL[e.tier]} social fee ${formatINR(base)}`, adj.note, disc?.words].filter(Boolean).join(" · ");
  const line = priceLine(
    {
      description: `Social play: ${input.title} — ${input.player.name}`,
      qty: 1,
      unitPrice: adj.price,
      discountPct: disc?.pct ?? 0,
      discountAmount: disc?.amount,
      taxCategory: "COURT",
      hsnSac: s.sac_codes.COURT,
      explanation,
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

/**
 * PR-5: price × (1 − shop_discount_pct), also for services; delivery fee is never discounted. v3 PR-10: the price is
 * the variant's price-book price; the customer gets the best single of the plan discount and any promotion.
 */
export async function quoteShop(
  db: Db,
  input: { memberId?: string | null; date: string; items: ShopItem[]; deliveryFee?: number; at?: Date },
  settings?: Settings,
): Promise<Quote> {
  const s = settings ?? (await getSettings(db as Tx));
  // `at`: the moment rules and prices are taken from (the price simulator); otherwise now.
  const now = input.at ?? clockNow();
  const e = await entitlementsFor(db, { memberId: input.memberId }, input.date, s);
  const rules = await rulesInEffect(db, now, "PRODUCTS");
  const variants = await db.productVariant.findMany({ where: { id: { in: input.items.map((i) => i.variantId) } }, select: { id: true, product: { select: { id: true, category: true } } } });
  const book = await bookPrices(db, input.items.map((i) => `VARIANT:${i.variantId}`), now);
  const lines: PricedLine[] = [];
  for (const it of input.items) {
    const price = book.get(`VARIANT:${it.variantId}`) ?? it.price;
    const v = variants.find((x) => x.id === it.variantId);
    const t: RuleTarget = { scope: "PRODUCTS", date: input.date, minute: istMinute(now), tier: e.tier, productId: v?.product.id ?? null, productCategory: v?.product.category ?? null };
    const plan = { pct: e.shopDiscountPct, label: TIER_LABEL[e.tier] };
    const disc = rules.length ? bestDiscount(rules, t, price, it.qty, plan) : null;
    lines.push(
      priceLine(
        {
          description: it.name,
          qty: it.qty,
          unitPrice: price,
          discountPct: disc ? disc.pct : e.shopDiscountPct,
          discountAmount: disc?.amount,
          taxCategory: asTaxCategory(it.taxCategory),
          hsnSac: it.hsnSac,
          explanation: disc?.promo
            ? `${TIER_LABEL[e.tier]} · ${disc.words}`
            : e.shopDiscountPct
              ? `${TIER_LABEL[e.tier]} · ${e.shopDiscountPct}% shop discount`
              : `${TIER_LABEL[e.tier]} · no discount`,
          variantId: it.variantId,
        },
        s,
      ),
    );
  }
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

/** PR-6: menu price × (1 − bar_discount_pct) based on the tab's payer; v3 PR-10: price book + best single discount. */
export async function quoteBar(
  db: Db,
  input: { memberId?: string | null; date: string; items: BarItem[]; at?: Date },
  settings?: Settings,
): Promise<Quote> {
  const s = settings ?? (await getSettings(db as Tx));
  // `at`: the moment rules and prices are taken from (the price simulator); otherwise now.
  const now = input.at ?? clockNow();
  const e = await entitlementsFor(db, { memberId: input.memberId }, input.date, s);
  const rules = await rulesInEffect(db, now, "MENU");
  const items = await db.menuItem.findMany({ where: { id: { in: input.items.map((i) => i.menuItemId) } }, select: { id: true, category: true } });
  const lines: PricedLine[] = [];
  for (const it of input.items) {
    const price = await bookPrice(db, `MENU:${it.menuItemId}`, now, it.price);
    const t: RuleTarget = { scope: "MENU", date: input.date, minute: istMinute(now), tier: e.tier, menuItemId: it.menuItemId, menuCategory: items.find((x) => x.id === it.menuItemId)?.category ?? null };
    const disc = rules.length ? bestDiscount(rules, t, price, it.qty, { pct: e.barDiscountPct, label: TIER_LABEL[e.tier] }) : null;
    lines.push(
      priceLine(
        {
          description: it.name,
          qty: it.qty,
          unitPrice: price,
          discountPct: disc ? disc.pct : e.barDiscountPct,
          discountAmount: disc?.amount,
          taxCategory: asTaxCategory(it.taxCategory),
          hsnSac: it.hsnSac,
          explanation: disc?.promo
            ? `${TIER_LABEL[e.tier]} · ${disc.words}`
            : e.barDiscountPct
              ? `${TIER_LABEL[e.tier]} · ${e.barDiscountPct}% bar discount`
              : `${TIER_LABEL[e.tier]} · no discount`,
          menuItemId: it.menuItemId,
        },
        s,
      ),
    );
  }
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
  const known: TaxCategory[] = ["COURT", "MEMBERSHIP", "GOODS_5", "GOODS_18", "SERVICE", "RESTAURANT", "OUTSIDE_GST", "DELIVERY", "BUSINESS_SERVICE"];
  if ((known as string[]).includes(c)) return c as TaxCategory;
  throw new DomainError("VALIDATION_FAILED", `Unknown tax category ${c}.`);
}

// ───────────── v3 §9.2 price book: dated base prices and manager-controlled rules (PR-10…PR-12) ─────────────

export type PriceRuleRow = {
  id: string; code: string; kind: string; name: string; scope: string; sports: string[]; courtIds: string[]; productCategories: string[];
  productIds: string[]; menuCategories: string[]; menuItemIds: string[]; daysOfWeek: number[]; startMinute: number | null; endMinute: number | null;
  dateFrom: Date | null; dateTo: Date | null; adjustType: string; adjustPct: number | null; fixedPrices: unknown; flatAmount: number | null;
  audience: string; tiers: string[]; priority: number;
};

/** PR-12: the base price in effect at `at` — the latest price-book version, else the record's own value. */
export async function bookPrice(db: Db, target: string, at: Date, fallback: number): Promise<number> {
  const row = await db.priceChange.findFirst({ where: { target, cancelledAt: null, effectiveAt: { lte: at } }, orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }], select: { price: true } });
  return row?.price ?? fallback;
}

/** bookPrice for many targets in one query (the shop catalogue and carts): target → price in effect at `at`. */
export async function bookPrices(db: Db, targets: string[], at: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!targets.length) return out;
  const rows = await db.priceChange.findMany({ where: { target: { in: [...new Set(targets)] }, cancelledAt: null, effectiveAt: { lte: at } }, orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }], select: { target: true, price: true } });
  for (const r of rows) if (!out.has(r.target)) out.set(r.target, r.price);
  return out;
}

/** Rules in effect at `at` (approved, inside their effective period). */
export async function rulesInEffect(db: Db, at: Date, scope?: string): Promise<PriceRuleRow[]> {
  return db.priceRule.findMany({
    where: { status: "ACTIVE", scope, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

/** What a rule needs to know about the thing being priced. */
export type RuleTarget = {
  scope: "COURTS" | "SOCIAL" | "PRODUCTS" | "MENU";
  date: string; // IST date of service
  minute: number | null; // IST minute of the day of service (start of the session / time of sale)
  tier: Tier;
  sport?: string | null; courtId?: string | null; productId?: string | null; productCategory?: string | null; menuItemId?: string | null; menuCategory?: string | null;
};

const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const ruleWindow = (r: Pick<PriceRuleRow, "startMinute" | "endMinute">) => (r.startMinute === null || r.endMinute === null ? "" : `${hhmmOf(r.startMinute)}–${hhmmOf(r.endMinute)}`);

function matches(r: PriceRuleRow, t: RuleTarget): boolean {
  if (r.scope !== t.scope) return false;
  if (t.scope === "COURTS") {
    if (r.sports.length && !(t.sport && r.sports.includes(t.sport))) return false;
    if (r.courtIds.length && !(t.courtId && r.courtIds.includes(t.courtId))) return false;
  }
  if (t.scope === "PRODUCTS" && (r.productCategories.length || r.productIds.length)) {
    if (!((t.productCategory && r.productCategories.includes(t.productCategory)) || (t.productId && r.productIds.includes(t.productId)))) return false;
  }
  if (t.scope === "MENU" && (r.menuCategories.length || r.menuItemIds.length)) {
    if (!((t.menuCategory && r.menuCategories.includes(t.menuCategory)) || (t.menuItemId && r.menuItemIds.includes(t.menuItemId)))) return false;
  }
  if (r.dateFrom && t.date < fromDbDate(r.dateFrom)) return false;
  if (r.dateTo && t.date > fromDbDate(r.dateTo)) return false;
  if (r.daysOfWeek.length && !r.daysOfWeek.includes(new Date(`${t.date}T00:00:00Z`).getUTCDay())) return false;
  if (r.startMinute !== null && r.endMinute !== null && (t.minute === null || t.minute < r.startMinute || t.minute >= r.endMinute)) return false;
  if (r.audience === "WALK_IN" && t.tier !== "WALK_IN") return false;
  if (r.audience === "TIERS" && !r.tiers.includes(t.tier)) return false;
  return true;
}

/** More specific scopes win among same-priority rules (a court beats a sport beats everything). */
const specificity = (r: PriceRuleRow) => (r.courtIds.length || r.productIds.length || r.menuItemIds.length ? 2 : r.sports.length || r.productCategories.length || r.menuCategories.length ? 1 : 0);
const pickRule = (rs: PriceRuleRow[]) => [...rs].sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a))[0] ?? null;

const signedPct = (p: number) => `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;

/** PR-10 step 2: a special date overrides; otherwise a time band applies. Returns the adjusted unit price. */
export function adjustBase(rules: PriceRuleRow[], t: RuleTarget, base: number): { price: number; note: string | null } {
  const special = pickRule(rules.filter((r) => r.kind === "SPECIAL_DATE" && matches(r, t)));
  const rule = special ?? pickRule(rules.filter((r) => r.kind === "BAND" && matches(r, t)));
  if (!rule) return { price: base, note: null };
  const label = [rule.name, ruleWindow(rule)].filter(Boolean).join(" ");
  if (rule.adjustType === "FIXED") {
    const fixed = (rule.fixedPrices as Record<string, number> | null)?.[t.tier];
    if (fixed === undefined || fixed === null) return { price: base, note: null };
    return { price: fixed, note: `${label} ${formatINR(fixed)}` };
  }
  const pct = rule.adjustPct ?? 0;
  return { price: Math.max(0, base + Math.round((base * pct) / 100)), note: `${label} ${signedPct(pct)}` };
}

/**
 * PR-10 step 3: the single best discount — the plan's % or an eligible promotion — never stacked. Returns the
 * discount for the whole line (amount) and the words for the explanation.
 */
export function bestDiscount(rules: PriceRuleRow[], t: RuleTarget, unitPrice: number, qty: number, plan: { pct: number; label: string } | null) {
  const gross = unitPrice * qty;
  const options: Array<{ amount: number; pct: number; label: string; promo: boolean; priority: number }> = [];
  if (plan && plan.pct > 0) options.push({ amount: percentOf(gross, plan.pct), pct: plan.pct, label: `${plan.label} −${plan.pct}%`, promo: false, priority: -1 });
  for (const r of rules.filter((x) => x.kind === "PROMOTION" && matches(x, t))) {
    const window = ruleWindow(r);
    if (r.adjustType === "FLAT" && r.flatAmount) options.push({ amount: Math.min(gross, r.flatAmount * qty), pct: 0, label: `${r.name}${window ? ` ${window}` : ""} −${formatINR(r.flatAmount)}`, promo: true, priority: r.priority });
    else if (r.adjustType === "PCT" && r.adjustPct) options.push({ amount: percentOf(gross, r.adjustPct), pct: r.adjustPct, label: `${r.name}${window ? ` ${window}` : ""} −${r.adjustPct}%`, promo: true, priority: r.priority });
  }
  if (!options.length) return null;
  const best = [...options].sort((a, b) => b.amount - a.amount || b.priority - a.priority)[0];
  const runnerUp = options.filter((o) => o !== best).sort((a, b) => b.amount - a.amount)[0];
  const words = runnerUp ? `${best.label} (better than ${runnerUp.label.replace(/^.*? −/, runnerUp.promo ? `${runnerUp.label.split(" −")[0]} −` : "plan −")})` : best.label;
  return { amount: Math.min(gross, best.amount), pct: best.pct, words, promo: best.promo };
}
