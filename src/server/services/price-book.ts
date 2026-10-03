// v3 §9.2 the price book: base prices (court and social fees per tier, product and menu prices), time bands, special
// dates and promotions — managed by the Owner (v4 RN-3: the Manager's v3 PR-11 rights are gone), applied only by the
// pricing engine (pricing.ts). Nothing here computes a customer's price except the simulator, which calls the engine.
// D-79: shop staff (`shop.pricing`) also set shop product prices and discounts on shop products (scope PRODUCTS) only.
//
// PR-11 guardrails (v4 RN-3): a shop-staff discount above `max_staff_discount_pct`, or a flat-₹ promotion by anyone but
// the Owner, waits for the Owner's approval — the Owner is the only approver. PR-12: every change has an
// effective datetime (now or later), is versioned (a base price is a new dated row; a rule is ended and replaced,
// never edited) and audited; bills keep their snapshots.
import type { Sport } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { dbDate, fromDbDate, isValidDateStr, istDate, timeToMinutes } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { quoteBar, quoteCourt, quoteShop, quoteSocial, ruleWindow, rulesInEffect, type PlayerRef, type Tier } from "./pricing";
import { getSettings, updateSetting } from "./settings";

const TIERS = ["GOLD", "SILVER", "JUNIOR", "WALK_IN"] as const;
const SPORTS = ["TENNIS", "CRICKET", "PADEL", "BADMINTON"] as const;

// ───────── base prices ─────────

export const basePriceSchema = z.object({
  target: z.string().regex(/^(COURT_FEE:(GOLD|SILVER|JUNIOR|WALK_IN):(TENNIS|CRICKET|PADEL|BADMINTON)|SOCIAL_FEE:(GOLD|SILVER|JUNIOR|WALK_IN)|VARIANT:.+|MENU:.+)$/, "Unknown price."),
  price: z.number().int().min(0),
  /** ISO datetime; empty = now. */
  effectiveAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(200).optional(),
});

/** Keep the record's own price field in step once a change is in effect (screens that show it stay right). */
async function syncRecord(tx: Tx, actor: Actor, target: string, price: number) {
  const [kind, a, b] = target.split(":");
  if (kind === "VARIANT") await tx.productVariant.update({ where: { id: a }, data: { price } });
  else if (kind === "MENU") await tx.menuItem.update({ where: { id: a }, data: { price } });
  else if (kind === "COURT_FEE" && a !== "WALK_IN") {
    const plan = await tx.plan.findUnique({ where: { code: a as "GOLD" | "SILVER" | "JUNIOR" } });
    if (plan) await tx.planCourtFee.upsert({ where: { planId_sport: { planId: plan.id, sport: b as Sport } }, create: { planId: plan.id, sport: b as Sport, fee: price }, update: { fee: price } });
  } else if (kind === "SOCIAL_FEE" && a !== "WALK_IN") {
    await tx.plan.updateMany({ where: { code: a as "GOLD" | "SILVER" | "JUNIOR" }, data: { socialFee: price } });
  } else if (a === "WALK_IN") {
    const s = await getSettings(tx);
    const walk = { ...s.walk_in, court_fee: { ...s.walk_in.court_fee } };
    if (kind === "COURT_FEE") walk.court_fee[b as Sport] = price;
    else walk.social_fee = price;
    await tx.setting.update({ where: { key: "walk_in" }, data: { value: walk } });
  }
  void actor;
}

async function assertTarget(tx: Tx, actor: Actor, target: string) {
  const [kind, id] = target.split(":");
  if (kind === "VARIANT") {
    // D-79: shop staff price shop products (and only those).
    if (!can(actor, "shop.pricing")) throw new DomainError("FORBIDDEN", "Not allowed: you can't change shop prices.", { capability: "shop.pricing" });
    if (!(await tx.productVariant.findUnique({ where: { id } }))) throw new DomainError("NOT_FOUND", "Product was not found.");
  } else {
    assertCan(actor, "pricing.manage");
    if (kind === "MENU" && !(await tx.menuItem.findUnique({ where: { id } }))) throw new DomainError("NOT_FOUND", "Menu item was not found.");
  }
}

/** PR-12: a new dated version of a base price — in effect now, or from a later date and time. */
export async function setBasePriceTx(tx: Tx, actor: Actor, raw: z.input<typeof basePriceSchema>) {
  const input = basePriceSchema.parse(raw);
  await assertTarget(tx, actor, input.target);
  const now = clock.now();
  const at = input.effectiveAt ? new Date(input.effectiveAt) : now;
  if (at.getTime() < now.getTime() - 60_000) throw new DomainError("VALIDATION_FAILED", "A price change can't start in the past.");
  const row = await tx.priceChange.create({ data: { target: input.target, price: input.price, effectiveAt: at, note: input.note ?? null, createdBy: actorId(actor) } });
  if (at.getTime() <= now.getTime()) await syncRecord(tx, actor, input.target, input.price);
  await audit(tx, actor, "price.change", "price_change", row.id, { after: { target: input.target, price: input.price, effectiveAt: at }, reason: input.note ?? null });
  return row;
}

export async function setBasePrice(actor: Actor, raw: z.input<typeof basePriceSchema>) {
  return withTx((tx) => setBasePriceTx(tx, actor, raw));
}

/** A scheduled change that hasn't started can be withdrawn. */
export async function cancelPriceChange(actor: Actor, id: string) {
  return withTx(async (tx) => {
    const row = await tx.priceChange.findUnique({ where: { id } });
    if (!row) throw new DomainError("NOT_FOUND", "Price change was not found.");
    await assertTarget(tx, actor, row.target);
    if (row.cancelledAt || row.effectiveAt.getTime() <= clock.now().getTime()) throw new DomainError("ORDER_STATE_INVALID", "Only a change that hasn't started yet can be withdrawn.");
    await tx.priceChange.update({ where: { id }, data: { cancelledAt: clock.now() } });
    await audit(tx, actor, "price.change_cancelled", "price_change", id, { before: { target: row.target, price: row.price, effectiveAt: row.effectiveAt } });
    return { id };
  });
}

/** Job: a scheduled change that has started updates the record's own price field (the engine already uses it). */
export async function applyDuePriceChanges() {
  const now = clock.now();
  const due = await prisma.$queryRaw<{ id: string; target: string; price: number }[]>`
    SELECT DISTINCT ON (target) id, target, price FROM price_changes
     WHERE cancelled_at IS NULL AND effective_at <= ${now} AND created_at < effective_at
     ORDER BY target, effective_at DESC, created_at DESC`;
  let applied = 0;
  for (const d of due) {
    await withTx(async (tx) => {
      const [kind, id] = d.target.split(":");
      const current = kind === "VARIANT" ? (await tx.productVariant.findUnique({ where: { id } }))?.price : kind === "MENU" ? (await tx.menuItem.findUnique({ where: { id } }))?.price : undefined;
      if (current === d.price) return;
      await syncRecord(tx, { kind: "SYSTEM", name: "price-book" }, d.target, d.price);
      applied++;
    });
  }
  return { applied };
}

// ───────── rules: time bands, special dates, promotions ─────────

const time = z.string().regex(/^\d{2}:\d{2}$/);
export const ruleSchema = z.object({
  kind: z.enum(["BAND", "SPECIAL_DATE", "PROMOTION"]),
  name: z.string().trim().min(2).max(60),
  scope: z.enum(["COURTS", "SOCIAL", "PRODUCTS", "MENU"]),
  sports: z.array(z.enum(SPORTS)).default([]),
  courtIds: z.array(z.string()).default([]),
  productCategories: z.array(z.string()).default([]),
  productIds: z.array(z.string()).default([]),
  menuCategories: z.array(z.string()).default([]),
  menuItemIds: z.array(z.string()).default([]),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  startTime: time.optional(),
  endTime: time.optional(),
  dateFrom: z.string().refine(isValidDateStr).optional(),
  dateTo: z.string().refine(isValidDateStr).optional(),
  adjustType: z.enum(["PCT", "FIXED", "FLAT"]),
  adjustPct: z.number().int().min(-90).max(300).optional(),
  fixedPrices: z.partialRecord(z.enum(TIERS), z.number().int().min(0)).optional(),
  flatAmount: z.number().int().min(1).optional(),
  audience: z.enum(["ALL", "TIERS", "WALK_IN"]).default("ALL"),
  tiers: z.array(z.enum(TIERS)).default([]),
  priority: z.number().int().min(0).max(100).default(0),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveTo: z.string().datetime({ offset: true }).optional(),
});
export type RuleInput = z.input<typeof ruleSchema>;

function shape(input: z.infer<typeof ruleSchema>) {
  const startMinute = input.startTime ? timeToMinutes(input.startTime) : null;
  const endMinute = input.endTime ? timeToMinutes(input.endTime) : null;
  if ((startMinute === null) !== (endMinute === null)) throw new DomainError("VALIDATION_FAILED", "Give both a start and an end time, or neither.");
  if (startMinute !== null && endMinute !== null && endMinute <= startMinute) throw new DomainError("VALIDATION_FAILED", "The time window must end after it starts.");
  if (input.kind === "PROMOTION") {
    if (input.adjustType === "FIXED") throw new DomainError("VALIDATION_FAILED", "A promotion is a % or a flat ₹ discount.");
    if (input.adjustType === "PCT" && !(input.adjustPct && input.adjustPct > 0 && input.adjustPct <= 100)) throw new DomainError("VALIDATION_FAILED", "A % promotion is between 1 and 100%.");
    if (input.adjustType === "FLAT" && !input.flatAmount) throw new DomainError("VALIDATION_FAILED", "Enter the ₹ discount.");
  } else {
    if (!["COURTS", "SOCIAL"].includes(input.scope)) throw new DomainError("VALIDATION_FAILED", "Time bands and special dates apply to courts and social play.");
    if (input.adjustType === "FLAT") throw new DomainError("VALIDATION_FAILED", "A band or special date is a % adjustment or a fixed price per tier.");
    if (input.adjustType === "PCT" && !input.adjustPct) throw new DomainError("VALIDATION_FAILED", "Enter the % adjustment (e.g. 20 or −10).");
    if (input.adjustType === "FIXED" && !Object.keys(input.fixedPrices ?? {}).length) throw new DomainError("VALIDATION_FAILED", "Enter the fixed price for at least one tier.");
    if (input.kind === "BAND" && (startMinute === null || !input.daysOfWeek.length)) throw new DomainError("VALIDATION_FAILED", "A time band needs days of the week and a time window.");
    if (input.kind === "SPECIAL_DATE" && !input.dateFrom) throw new DomainError("VALIDATION_FAILED", "A special date needs a date.");
  }
  if (input.audience === "TIERS" && !input.tiers.length) throw new DomainError("VALIDATION_FAILED", "Choose the tiers the rule is for.");
  return {
    kind: input.kind, name: input.name, scope: input.scope, sports: input.scope === "COURTS" ? input.sports : [], courtIds: input.scope === "COURTS" ? input.courtIds : [],
    productCategories: input.scope === "PRODUCTS" ? input.productCategories : [], productIds: input.scope === "PRODUCTS" ? input.productIds : [],
    menuCategories: input.scope === "MENU" ? input.menuCategories : [], menuItemIds: input.scope === "MENU" ? input.menuItemIds : [],
    daysOfWeek: input.daysOfWeek, startMinute, endMinute,
    dateFrom: input.dateFrom ? dbDate(input.dateFrom) : null, dateTo: input.dateTo ? dbDate(input.dateTo) : input.kind === "SPECIAL_DATE" && input.dateFrom ? dbDate(input.dateFrom) : null,
    adjustType: input.adjustType, adjustPct: input.adjustType === "PCT" ? input.adjustPct ?? null : null,
    fixedPrices: input.adjustType === "FIXED" ? input.fixedPrices ?? {} : undefined, flatAmount: input.adjustType === "FLAT" ? input.flatAmount ?? null : null,
    audience: input.audience, tiers: input.audience === "TIERS" ? input.tiers : [], priority: input.priority,
  };
}

type Shaped = ReturnType<typeof shape>;
const overlaps = (a: number[], b: number[]) => !a.length || !b.length || a.some((x) => b.includes(x));
const listOverlap = (a: string[], b: string[]) => !a.length || !b.length || a.some((x) => b.includes(x));

/** Bands can't overlap for the same scope (same sport/court, day and time, while both are in effect). */
async function assertNoBandOverlap(tx: Tx, r: Shaped, from: Date, to: Date | null, ignoreId?: string) {
  if (r.kind !== "BAND") return;
  const others = await tx.priceRule.findMany({ where: { kind: "BAND", scope: r.scope, status: { in: ["ACTIVE", "PENDING_APPROVAL"] }, id: ignoreId ? { not: ignoreId } : undefined } });
  for (const o of others) {
    const timeOverlap = o.startMinute! < r.endMinute! && r.startMinute! < o.endMinute!;
    const periodOverlap = (o.effectiveTo === null || o.effectiveTo > from) && (to === null || o.effectiveFrom < to);
    if (timeOverlap && periodOverlap && overlaps(o.daysOfWeek, r.daysOfWeek) && listOverlap(o.sports, r.sports) && listOverlap(o.courtIds, r.courtIds)) {
      throw new DomainError("PRICE_BAND_OVERLAP", `“${o.name}” (${o.code}) already covers ${ruleWindow(o)} on some of the same days for the same courts.`, { conflict: o.code });
    }
  }
}

/** PR-11 / v4 RN-3: who may switch this on without the Owner. Only the Owner and shop staff create rules now. */
async function needsApproval(tx: Tx, actor: Actor, r: Shaped): Promise<string | null> {
  if (actor.kind !== "USER" || actor.role === "OWNER") return null;
  if (r.kind !== "PROMOTION") return null;
  const s = await getSettings(tx);
  if (r.adjustType === "FLAT") return "a flat ₹ promotion needs the Owner's approval";
  const limit = s.max_staff_discount_pct;
  return (r.adjustPct ?? 0) > limit ? `above the ${limit}% limit for shop staff` : null;
}

/** Who may create, change or end this rule. D-79: shop staff only a discount on shop products (never courts, social, menu). */
function assertMayCreate(actor: Actor, r: { kind: string; scope: string }) {
  if (can(actor, "pricing.manage")) return;
  if (can(actor, "shop.pricing") && r.kind === "PROMOTION" && r.scope === "PRODUCTS") return;
  throw new DomainError("FORBIDDEN", "Not allowed: only the owner can change pricing rules.");
}

async function createRuleTx(tx: Tx, actor: Actor, input: z.infer<typeof ruleSchema>, replacesId?: string) {
  const r = shape(input);
  assertMayCreate(actor, r);
  const now = clock.now();
  const from = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
  const to = input.effectiveTo ? new Date(input.effectiveTo) : null;
  if (from.getTime() < now.getTime() - 60_000) throw new DomainError("VALIDATION_FAILED", "A rule can't start in the past.");
  await assertNoBandOverlap(tx, r, from, to, replacesId);
  const why = await needsApproval(tx, actor, r);
  const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('price_rule_code_seq') AS n`;
  const row = await tx.priceRule.create({
    data: {
      ...r, code: `PR-${String(Number(n)).padStart(5, "0")}`, status: why ? "PENDING_APPROVAL" : "ACTIVE", effectiveFrom: from, effectiveTo: to, replacesId: replacesId ?? null,
      createdBy: actorId(actor), approvedBy: why ? null : actorId(actor), approvedAt: why ? null : now,
    },
  });
  await audit(tx, actor, "price_rule.create", "price_rule", row.id, { after: { ...r, code: row.code, status: row.status, effectiveFrom: from, effectiveTo: to }, reason: why });
  return { ...row, approvalNeeded: why };
}

export async function createRule(actor: Actor, raw: RuleInput) {
  return withTx((tx) => createRuleTx(tx, actor, ruleSchema.parse(raw)));
}

/** PR-12: a change never edits a rule — the old version ends when the new one starts. */
export async function changeRule(actor: Actor, id: string, raw: RuleInput) {
  const input = ruleSchema.parse(raw);
  return withTx(async (tx) => {
    const old = await tx.priceRule.findUnique({ where: { id } });
    if (!old || old.status === "REJECTED") throw new DomainError("NOT_FOUND", "Rule was not found.");
    assertMayCreate(actor, old); // replacing ends the old rule, so the actor must be allowed to end it
    const from = input.effectiveFrom ? new Date(input.effectiveFrom) : clock.now();
    const next = await createRuleTx(tx, actor, input, old.id);
    await tx.priceRule.update({ where: { id: old.id }, data: { effectiveTo: from } });
    await audit(tx, actor, "price_rule.replaced", "price_rule", old.id, { before: { effectiveTo: old.effectiveTo }, after: { effectiveTo: from, replacedBy: next.code } });
    return next;
  });
}

export async function endRule(actor: Actor, id: string, at?: string) {
  return withTx(async (tx) => {
    const r = await tx.priceRule.findUnique({ where: { id } });
    if (!r) throw new DomainError("NOT_FOUND", "Rule was not found.");
    assertMayCreate(actor, r);
    const when = at ? new Date(at) : clock.now();
    await tx.priceRule.update({ where: { id }, data: { effectiveTo: when, status: when.getTime() <= clock.now().getTime() ? "ENDED" : r.status } });
    await audit(tx, actor, "price_rule.end", "price_rule", id, { before: { effectiveTo: r.effectiveTo, status: r.status }, after: { effectiveTo: when } });
    return { id, effectiveTo: when };
  });
}

/** v4 RN-3: only the Owner approves or rejects a waiting rule (`pricing.manage` is the Owner's alone). */
export async function decideRule(actor: Actor, id: string, decision: "APPROVE" | "REJECT") {
  assertCan(actor, "pricing.manage");
  return withTx(async (tx) => {
    const r = await tx.priceRule.findUnique({ where: { id } });
    if (!r) throw new DomainError("NOT_FOUND", "Rule was not found.");
    if (r.status !== "PENDING_APPROVAL") throw new DomainError("ORDER_STATE_INVALID", `This rule is ${r.status.toLowerCase().replace("_", " ")}.`);
    if (actor.kind === "USER" && actor.userId === r.createdBy) throw new DomainError("FORBIDDEN", "Not allowed: you can't approve your own rule.");
    if (decision === "APPROVE") await assertNoBandOverlap(tx, r as unknown as Shaped, r.effectiveFrom, r.effectiveTo, r.id);
    const now = clock.now();
    await tx.priceRule.update({ where: { id }, data: decision === "APPROVE" ? { status: "ACTIVE", approvedBy: actorId(actor), approvedAt: now, effectiveFrom: r.effectiveFrom < now ? now : r.effectiveFrom } : { status: "REJECTED" } });
    await audit(tx, actor, decision === "APPROVE" ? "price_rule.approve" : "price_rule.reject", "price_rule", id, { before: { status: r.status }, after: { status: decision === "APPROVE" ? "ACTIVE" : "REJECTED" } });
    return { id, status: decision === "APPROVE" ? "ACTIVE" : "REJECTED" };
  });
}

/** PR-11: guardrails are Owner-only (they are settings). */
export async function setGuardrails(actor: Actor, raw: { maxManagerDiscountPct?: number; maxStaffDiscountPct?: number }) {
  if (raw.maxManagerDiscountPct !== undefined) await updateSetting(actor, "max_manager_discount_pct", raw.maxManagerDiscountPct);
  if (raw.maxStaffDiscountPct !== undefined) await updateSetting(actor, "max_staff_discount_pct", raw.maxStaffDiscountPct);
  return getSettings();
}

// ───────── the page: everything in the price book ─────────

export async function priceBook(actor: Actor) {
  if (!can(actor, "pricing.manage")) throw new DomainError("FORBIDDEN", "Not allowed: the price book is for the owner.");
  const now = clock.now();
  const s = await getSettings();
  const changes = await prisma.priceChange.findMany({ where: { cancelledAt: null }, orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }], take: 2000 });
  const current = (target: string) => changes.find((c) => c.target === target && c.effectiveAt <= now) ?? null;
  const scheduled = (target: string) => changes.filter((c) => c.target === target && c.effectiveAt > now).map((c) => ({ id: c.id, price: c.price, effectiveAt: c.effectiveAt }));
  const plans = await prisma.plan.findMany({ include: { courtFees: true } });
  const legacy = (tier: string, sport: string) => (tier === "WALK_IN" ? s.walk_in.court_fee[sport as Sport] : plans.find((p) => p.code === tier)?.courtFees.find((f) => f.sport === sport)?.fee ?? 0);
  const legacySocial = (tier: string) => (tier === "WALK_IN" ? s.walk_in.social_fee : plans.find((p) => p.code === tier)?.socialFee ?? 0);
  const fees = TIERS.map((tier) => ({
    tier,
    court: Object.fromEntries(SPORTS.map((sport) => [sport, { target: `COURT_FEE:${tier}:${sport}`, price: current(`COURT_FEE:${tier}:${sport}`)?.price ?? legacy(tier, sport), scheduled: scheduled(`COURT_FEE:${tier}:${sport}`) }])),
    social: { target: `SOCIAL_FEE:${tier}`, price: current(`SOCIAL_FEE:${tier}`)?.price ?? legacySocial(tier), scheduled: scheduled(`SOCIAL_FEE:${tier}`) },
  }));
  const [variants, menu, rules, courts] = await Promise.all([
    prisma.productVariant.findMany({ where: { archivedAt: null, product: { archivedAt: null } }, include: { product: { select: { name: true, category: true } } }, orderBy: [{ product: { name: "asc" } }, { label: "asc" }] }),
    prisma.menuItem.findMany({ where: { archivedAt: null }, orderBy: [{ category: "asc" }, { sortOrder: "asc" }] }),
    prisma.priceRule.findMany({ orderBy: [{ createdAt: "desc" }], take: 500 }),
    prisma.court.findMany({ where: { archivedAt: null }, select: { id: true, name: true, sport: true }, orderBy: { sortOrder: "asc" } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: [...rules.map((r) => r.createdBy), ...rules.map((r) => r.approvedBy)].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const who = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  const ruleState = (r: (typeof rules)[number]) =>
    r.status !== "ACTIVE" ? r.status : r.effectiveTo && r.effectiveTo <= now ? "ENDED" : r.effectiveFrom > now ? "SCHEDULED" : "IN_EFFECT";
  return {
    now, canGuardrails: can(actor, "settings"),
    guardrails: { maxManagerDiscountPct: s.max_manager_discount_pct, maxStaffDiscountPct: s.max_staff_discount_pct },
    fees,
    products: variants.map((v) => ({ id: v.id, target: `VARIANT:${v.id}`, name: v.product.name, label: v.label, sku: v.sku, category: v.product.category, price: current(`VARIANT:${v.id}`)?.price ?? v.price, scheduled: scheduled(`VARIANT:${v.id}`) })),
    menu: menu.map((m) => ({ id: m.id, target: `MENU:${m.id}`, name: m.name, category: m.category, price: current(`MENU:${m.id}`)?.price ?? m.price, scheduled: scheduled(`MENU:${m.id}`) })),
    rules: rules.map((r) => ({ ...r, dateFrom: r.dateFrom ? fromDbDate(r.dateFrom) : null, dateTo: r.dateTo ? fromDbDate(r.dateTo) : null, window: ruleWindow(r), state: ruleState(r), createdByName: who(r.createdBy), approvedByName: who(r.approvedBy) })),
    courts,
    history: changes.filter((c) => c.createdBy).slice(0, 100),
  };
}

// ───────── PR-13 simulator (the real engine) ─────────

export const simulateSchema = z.object({
  offering: z.enum(["COURT", "SOCIAL", "PRODUCT", "MENU"]),
  tier: z.enum(TIERS),
  date: z.string().refine(isValidDateStr),
  time: time,
  courtId: z.string().optional(),
  variantId: z.string().optional(),
  menuItemId: z.string().optional(),
  qty: z.number().int().min(1).max(50).default(1),
});

/** A member of the chosen tier for the simulation: a real member whose plan covers the date, or a walk-in. */
async function sampleCustomer(tier: Tier, date: string): Promise<PlayerRef & { memberId?: string }> {
  if (tier === "WALK_IN") return { guestId: "simulated", name: "Walk-in" };
  const m = await prisma.membership.findFirst({ where: { plan: { code: tier }, status: { in: ["ACTIVE", "SCHEDULED", "EXPIRED"] }, startDate: { lte: dbDate(date) }, endDate: { gte: dbDate(date) } }, include: { member: true } });
  if (!m) throw new DomainError("VALIDATION_FAILED", `No ${tier.toLowerCase()} member has a plan on that date to price for — try another date or tier.`);
  return { memberId: m.memberId, name: `${tier.charAt(0)}${tier.slice(1).toLowerCase()} member` };
}

export async function simulatePrice(actor: Actor, raw: z.input<typeof simulateSchema>) {
  if (!can(actor, "pricing.manage")) throw new DomainError("FORBIDDEN", "Not allowed.");
  const input = simulateSchema.parse(raw);
  const customer = await sampleCustomer(input.tier, input.date);
  const memberId = "memberId" in customer ? customer.memberId ?? null : null;
  const minute = timeToMinutes(input.time);
  // Prices and rules as they will be at that moment (so a scheduled change can be previewed); never earlier than now.
  const when = new Date(`${input.date}T${input.time}:00+05:30`);
  const at = when.getTime() > clock.now().getTime() ? when : clock.now();
  if (input.offering === "COURT") {
    const court = await prisma.court.findUnique({ where: { id: input.courtId ?? "" } });
    if (!court) throw new DomainError("VALIDATION_FAILED", "Choose a court.");
    const q = await quoteCourt(prisma, { sport: court.sport, date: input.date, courtName: court.name, timeLabel: input.time, players: [customer], courtId: court.id, startMinute: minute, at });
    return { total: q.total, lines: q.players.map((p) => ({ description: p.description, unitPrice: p.unitPrice, discount: p.discountAmount, net: p.netAmount, explanation: p.explanation })) };
  }
  if (input.offering === "SOCIAL") {
    const q = await quoteSocial(prisma, { date: input.date, title: "Social play", player: customer, startMinute: minute, at });
    return { total: q.total, lines: q.lines.map((p) => ({ description: p.description, unitPrice: p.unitPrice, discount: p.discountAmount, net: p.netAmount, explanation: p.explanation })) };
  }
  // Shop and bar promotions follow the time of sale: priced as if sold at that date and time.
  if (input.offering === "PRODUCT") {
    const v = await prisma.productVariant.findUnique({ where: { id: input.variantId ?? "" }, include: { product: true } });
    if (!v) throw new DomainError("VALIDATION_FAILED", "Choose a product.");
    const q = await quoteShop(prisma, { memberId, date: input.date, at, items: [{ variantId: v.id, qty: input.qty, name: `${v.product.name} ${v.label}`, price: v.price, taxCategory: v.taxCategory, hsnSac: v.hsnSac }] });
    return { total: q.total, lines: q.lines.map((p) => ({ description: p.description, unitPrice: p.unitPrice, discount: p.discountAmount, net: p.netAmount, explanation: p.explanation })) };
  }
  const m = await prisma.menuItem.findUnique({ where: { id: input.menuItemId ?? "" } });
  if (!m) throw new DomainError("VALIDATION_FAILED", "Choose a menu item.");
  const q = await quoteBar(prisma, { memberId, date: input.date, at, items: [{ menuItemId: m.id, qty: input.qty, name: m.name, price: m.price, taxCategory: m.taxCategory, hsnSac: m.hsnSac }] });
  return { total: q.total, lines: q.lines.map((p) => ({ description: p.description, unitPrice: p.unitPrice, discount: p.discountAmount, net: p.netAmount, explanation: p.explanation })) };
}

// ───────── PR-14: what the public site and portal say about prices ─────────

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const days = (d: number[]) => (!d.length || d.length === 7 ? "every day" : d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? "weekdays" : d.length === 2 && d.includes(0) && d.includes(6) ? "weekends" : d.map((x) => DAY[x]).join(", "));

export async function publicPriceNotes() {
  const now = clock.now();
  const today = istDate(now);
  const rules = (await rulesInEffect(prisma, now)).filter((r) => r.kind !== "SPECIAL_DATE" || !r.dateTo || fromDbDate(r.dateTo) >= today);
  const courts = await prisma.court.findMany({ select: { id: true, name: true } });
  const what = (r: (typeof rules)[number]) =>
    r.scope === "SOCIAL" ? "Social play" : r.scope === "PRODUCTS" ? "Shop" : r.scope === "MENU" ? "Bar & café" :
      [r.sports.map((x) => x.charAt(0) + x.slice(1).toLowerCase()).join(", "), r.courtIds.map((id) => courts.find((c) => c.id === id)?.name).filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "Courts";
  const how = (r: (typeof rules)[number]) =>
    r.adjustType === "FIXED" ? `from ${formatINR(Math.min(...Object.values((r.fixedPrices ?? {}) as Record<string, number>)))}` :
      r.adjustType === "FLAT" ? `${formatINR(r.flatAmount ?? 0)} off` : r.kind === "PROMOTION" ? `${r.adjustPct}% off` : `${(r.adjustPct ?? 0) > 0 ? "+" : "−"}${Math.abs(r.adjustPct ?? 0)}%`;
  const audience = (r: (typeof rules)[number]) => (r.audience === "WALK_IN" ? " (walk-ins)" : r.audience === "TIERS" ? ` (${r.tiers.map((t) => t.charAt(0) + t.slice(1).toLowerCase().replace("_in", "-in")).join(", ")})` : "");
  return rules.map((r) => ({
    id: r.id, kind: r.kind, scope: r.scope, name: r.name,
    text: `${what(r)}: ${r.name} ${how(r)}${audience(r)} · ${r.kind === "SPECIAL_DATE" ? fmtDates(r.dateFrom, r.dateTo) : r.dateFrom || r.dateTo ? `${days(r.daysOfWeek)} ${fmtDates(r.dateFrom, r.dateTo)}` : days(r.daysOfWeek)}${ruleWindow(r) ? ` ${ruleWindow(r)}` : ""}`.trim(),
  }));
}

function fmtDates(a: Date | null, b: Date | null) {
  const f = (d: Date) => new Date(`${fromDbDate(d)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  if (a && b && fromDbDate(a) === fromDbDate(b)) return `on ${f(a)}`;
  return [a ? `from ${f(a)}` : "", b ? `until ${f(b)}` : ""].filter(Boolean).join(" ");
}

