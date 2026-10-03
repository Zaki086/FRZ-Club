// Membership plans and their entitlements (MP-1, MP-2, R-02, R-03). Seeded from §11.1, editable by the Owner.
import type { PlanCode, Prisma, Sport } from "@prisma/client";
import { z } from "zod";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";

const R = (r: number) => r * 100;
const SPORTS: Sport[] = ["TENNIS", "CRICKET", "PADEL", "BADMINTON"];

export const PLAN_DEFAULTS: Array<{
  code: PlanCode;
  name: string;
  description: string;
  price1m: number;
  price3m: number;
  price12m: number;
  courtFee: number;
  socialFee: number;
  shopDiscountPct: number;
  barDiscountPct: number;
  advanceBookingDays: number;
  alcoholAllowed: boolean;
  rank: number;
}> = [
  {
    code: "GOLD",
    name: "Gold",
    description: "Premium, full access: free courts, the best shop and bar discounts, 7-day advance booking.",
    price1m: R(3500), price3m: R(9500), price12m: R(35000),
    courtFee: 0, socialFee: 0, shopDiscountPct: 15, barDiscountPct: 15, advanceBookingDays: 7,
    alcoholAllowed: true, rank: 3,
  },
  {
    code: "SILVER",
    name: "Silver",
    description: "Standard membership: reduced court fees, 10% off at the shop and bar, 5-day advance booking.",
    price1m: R(2000), price3m: R(5400), price12m: R(20000),
    courtFee: R(150), socialFee: R(100), shopDiscountPct: 10, barDiscountPct: 10, advanceBookingDays: 5,
    alcoholAllowed: true, rank: 2,
  },
  {
    code: "JUNIOR",
    name: "Junior",
    description: "Under 18, discounted: low court fees, 10% shop and 5% bar discount, 3-day advance booking. No alcohol.",
    price1m: R(1200), price3m: R(3200), price12m: R(12000),
    courtFee: R(100), socialFee: R(50), shopDiscountPct: 10, barDiscountPct: 5, advanceBookingDays: 3,
    alcoholAllowed: false, rank: 1,
  },
];

/** Create the three plans with §11.1 defaults if they don't exist. Idempotent. */
export async function ensurePlans(outer?: Tx): Promise<void> {
  await withTx(async (tx) => {
    for (const p of PLAN_DEFAULTS) {
      const existing = await tx.plan.findUnique({ where: { code: p.code } });
      if (existing) continue;
      const plan = await tx.plan.create({
        data: {
          code: p.code, name: p.name, description: p.description,
          price1m: p.price1m, price3m: p.price3m, price12m: p.price12m,
          socialFee: p.socialFee, shopDiscountPct: p.shopDiscountPct, barDiscountPct: p.barDiscountPct,
          advanceBookingDays: p.advanceBookingDays, alcoholAllowed: p.alcoholAllowed, rank: p.rank,
        },
      });
      for (const sport of SPORTS) {
        await tx.planCourtFee.create({ data: { planId: plan.id, sport, fee: p.courtFee } });
      }
    }
  }, outer);
}

export async function listPlans(opts: { activeOnly?: boolean } = {}) {
  return prisma.plan.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    include: { courtFees: true },
    orderBy: { rank: "desc" },
  });
}

export type PlanWithFees = Awaited<ReturnType<typeof listPlans>>[number];

export function planPrice(plan: { price1m: number; price3m: number; price12m: number }, months: number): number {
  if (months === 1) return plan.price1m;
  if (months === 3) return plan.price3m;
  if (months === 12) return plan.price12m;
  throw new DomainError("VALIDATION_FAILED", "Membership duration must be 1, 3 or 12 months.");
}

export const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  description: z.string().max(500).optional(),
  price1m: z.number().int().min(0).optional(),
  price3m: z.number().int().min(0).optional(),
  price12m: z.number().int().min(0).optional(),
  socialFee: z.number().int().min(0).optional(),
  shopDiscountPct: z.number().int().min(0).max(100).optional(),
  barDiscountPct: z.number().int().min(0).max(100).optional(),
  advanceBookingDays: z.number().int().min(0).max(60).optional(),
  alcoholAllowed: z.boolean().optional(),
  active: z.boolean().optional(),
  courtFees: z
    .object({
      TENNIS: z.number().int().min(0),
      CRICKET: z.number().int().min(0),
      PADEL: z.number().int().min(0),
      BADMINTON: z.number().int().min(0),
    })
    .partial()
    .optional(),
});

/** Owner edits plan entitlements. Existing bills keep their snapshots (PR-8, MB-9). */
export async function updatePlan(actor: Actor, planId: string, raw: z.infer<typeof updatePlanSchema>) {
  assertCan(actor, "settings");
  const input = updatePlanSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await tx.plan.findUnique({ where: { id: planId }, include: { courtFees: true } });
    if (!before) throw new DomainError("NOT_FOUND", "Plan was not found.");
    const { courtFees, ...fields } = input;
    const data: Prisma.PlanUpdateInput = { ...fields };
    await tx.plan.update({ where: { id: planId }, data });
    if (courtFees) {
      for (const [sport, fee] of Object.entries(courtFees)) {
        if (fee === undefined) continue;
        await tx.planCourtFee.upsert({
          where: { planId_sport: { planId, sport: sport as Sport } },
          create: { planId, sport: sport as Sport, fee },
          update: { fee },
        });
      }
    }
    const after = await tx.plan.findUnique({ where: { id: planId }, include: { courtFees: true } });
    await audit(tx, actor, "plan.update", "plan", planId, { before, after });
    return after;
  });
}
