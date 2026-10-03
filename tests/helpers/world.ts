// Shared fixture: a fresh club with settings, plans, courts and one staff user per role — all created
// through the real services, exactly like the seed.
import type { Role } from "@prisma/client";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { ensureDefaultSettings } from "@/server/services/settings";
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
];

/** Default test "now": Monday 12 Oct 2026, 10:00 IST. */
export const T0 = istToUtc("2026-10-12", "10:00");

export async function makeWorld(now: Date = T0): Promise<World> {
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
  const plans = Object.fromEntries(
    (await prisma.plan.findMany()).map((p) => [p.code, { id: p.id }]),
  ) as World["plans"];
  return { actors, courts, plans };
}
