// Shared fixture: a fresh club with settings, plans, courts and one staff user per role — all created
// through the real services, exactly like the seed.
import type { Role } from "@prisma/client";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { DEFAULT_SETTINGS, ensureDefaultSettings, updateSetting, verifySetting } from "@/server/services/settings";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { ensureTill, openDrawer, type TillLocation } from "@/server/services/drawers";
import { gstinCheckChar } from "@/lib/codes";
import { ensurePlans } from "@/server/services/plans";
import { createCourt } from "@/server/services/courts";
import { createStaff } from "@/server/services/users";
import { resetDb } from "./db";

export const TEST_PASSWORD = "password123";

export type World = {
  actors: Record<Exclude<Role, "MEMBER">, UserActor>;
  courts: Record<string, { id: string; name: string; sport: string; maxPlayers: number }>;
  plans: Record<"GOLD" | "SILVER" | "JUNIOR", { id: string }>;
};

const STAFF: Array<{ role: Exclude<Role, "MEMBER">; name: string; phone: string }> = [
  { role: "OWNER", name: "Olivia Owner", phone: "9000000001" },
  { role: "MANAGER", name: "Manish Manager", phone: "9000000002" },
  { role: "FRONT_DESK", name: "Farah Desk", phone: "9000000003" },
  { role: "SHOP_STAFF", name: "Sameer Shop", phone: "9000000004" },
  { role: "BAR_STAFF", name: "Bina Bar", phone: "9000000005" },
  { role: "ACCOUNTANT", name: "Arjun Accounts", phone: "9000000006" },
  { role: "KITCHEN", name: "Kavi Kitchen", phone: "9000000007" },
];

/**
 * The till each staff member opens in a configured world. v6 TL-1 changed this (was: a front desk drawer for every
 * role, each getting its own numbered "Front Desk Till N"): each role opens a till at its own location (the Owner and
 * the Manager may open any; they keep front desk tills); the kitchen takes no money and has none.
 */
export const WORLD_TILLS: Partial<Record<Exclude<Role, "MEMBER">, { name: string; location: TillLocation }>> = {
  OWNER: { name: "Front Desk Till 1", location: "FRONT_DESK" },
  MANAGER: { name: "Front Desk Till 2", location: "FRONT_DESK" },
  FRONT_DESK: { name: "Front Desk Till 3", location: "FRONT_DESK" },
  SHOP_STAFF: { name: "Shop Till", location: "SHOP" },
  BAR_STAFF: { name: "Bar Till", location: "BAR" },
  ACCOUNTANT: { name: "Office Till", location: "OFFICE" },
};

/** Default test "now": Monday 12 Oct 2026, 10:00 IST. */
export const T0 = istToUtc("2026-10-12", "10:00");

/** A syntactically valid GSTIN (correct check digit) for a Gujarat-registered test club. */
/** The test club's identity (a fresh install has none until the setup wizard). */
export const TEST_CLUB = { ...DEFAULT_SETTINGS.club, name: "The Champions Club", address: "1 Test Road, Ahmedabad", state: "Gujarat", state_code: "24" };
export const TEST_GSTIN = "24AAACC1206D1Z" + gstinCheckChar("24AAACC1206D1Z");
export const TEST_UPI_VPA = "championsclub@okaxis";

let utrSeq = 100000000000;
/** A fresh 12-character UPI reference (UTR). */
export const utr = () => String(++utrSeq);
/** Card payments need the terminal approval code and the last 4 digits (§2.4). */
export const CARD_PROOF = { cardLast4: "4242", approvalCode: "AUTH01" } as const;

export type WorldOptions = {
  /** Fresh-install defaults: cash only, no GST, no email (capability tests use this). */
  minimal?: boolean;
};

export async function makeWorld(now: Date = T0, opts: WorldOptions = {}): Promise<World> {
  clock.set(now);
  await resetDb();
  await ensureDefaultSettings();
  await ensurePlans();
  const courts: World["courts"] = {};
  const defs: Array<[string, "TENNIS" | "CRICKET"]> = [
    ["Court 1", "TENNIS"], ["Court 2", "TENNIS"], ["Court 3", "TENNIS"], ["Court 4", "TENNIS"],
    ["Net A", "CRICKET"], ["Net B", "CRICKET"],
  ];
  for (const [i, [name, sport]] of defs.entries()) {
    const c = await createCourt(SYSTEM, { name, sport, sortOrder: i });
    courts[name] = { id: c.id, name: c.name, sport: c.sport, maxPlayers: c.maxPlayers };
  }
  const actors = {} as World["actors"];
  for (const s of STAFF) {
    const { user, employee } = await createStaff(SYSTEM, {
      name: s.name, phone: s.phone, email: `${s.role.toLowerCase()}@test.club`, role: s.role,
      password: TEST_PASSWORD, monthlySalary: 3_000_000, joinDate: "2025-01-01",
    });
    actors[s.role] = { kind: "USER", userId: user.id, role: s.role, name: s.name, memberId: null, employeeId: employee.id };
  }
  await updateSetting(SYSTEM, "club", TEST_CLUB);
  if (!opts.minimal) {
    // Most rule tests run in a fully configured club: card + UPI, GST registered, email verified, drawers open.
    await updateSetting(SYSTEM, "club", { ...TEST_CLUB, gstin: TEST_GSTIN, legal_name: "Champions Test Club LLP" });
    await verifySetting(SYSTEM, "tax_rates");
    await updateSetting(SYSTEM, "payment_methods", { card_enabled: true, upi_vpa: TEST_UPI_VPA, upi_confirmed: true });
    await updateSetting(SYSTEM, "delivery", { enabled: true, pincodes: ["380015", "380009", "380054"], fee: 9900 });
    setCapabilityOverridesForTests({ email: true });
    for (const a of Object.values(actors)) {
      const t = WORLD_TILLS[a.role as Exclude<Role, "MEMBER">];
      if (t) await openDrawer(a, { drawerId: (await ensureTill(SYSTEM, { ...t, defaultFloat: 0 })).id, openingFloat: 0 });
    }
  } else {
    setCapabilityOverridesForTests({});
  }
  const plans = Object.fromEntries(
    (await prisma.plan.findMany()).map((p) => [p.code, { id: p.id }]),
  ) as World["plans"];
  return { actors, courts, plans };
}
