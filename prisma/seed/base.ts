// Reference data: settings, plans, courts, staff logins (one per role, §11.2) and the demo personas.
// Everything goes through the real services.
import type { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { ensureDefaultSettings } from "@/server/services/settings";
import { ensurePlans } from "@/server/services/plans";
import { createCourt } from "@/server/services/courts";
import { createStaff } from "@/server/services/users";

export const STAFF_PASSWORD = "champions123";
export const MEMBER_PASSWORD = "member123";

export const STAFF_LOGINS: Array<{ role: Exclude<Role, "MEMBER">; name: string; phone: string; email: string; salary: number }> = [
  { role: "OWNER", name: "Vikram Rao", phone: "9000000001", email: "owner@championsclub.test", salary: 0 },
  { role: "MANAGER", name: "Meera Iyer", phone: "9000000002", email: "manager@championsclub.test", salary: 6_500_000 },
  { role: "FRONT_DESK", name: "Farah Khan", phone: "9000000003", email: "desk@championsclub.test", salary: 2_800_000 },
  { role: "FRONT_DESK", name: "Dev Patel", phone: "9000000004", email: "desk2@championsclub.test", salary: 2_600_000 },
  { role: "SHOP_STAFF", name: "Sameer Joshi", phone: "9000000005", email: "shop@championsclub.test", salary: 2_500_000 },
  { role: "BAR_STAFF", name: "Bina Thomas", phone: "9000000006", email: "bar@championsclub.test", salary: 2_400_000 },
  { role: "BAR_STAFF", name: "Raju Nair", phone: "9000000007", email: "bar2@championsclub.test", salary: 2_200_000 },
  { role: "ACCOUNTANT", name: "Anita Desai", phone: "9000000008", email: "accounts@championsclub.test", salary: 4_500_000 },
];

export const COURTS: Array<{ name: string; sport: "TENNIS" | "CRICKET" }> = [
  { name: "Court 1", sport: "TENNIS" },
  { name: "Court 2", sport: "TENNIS" },
  { name: "Court 3", sport: "TENNIS" },
  { name: "Court 4", sport: "TENNIS" },
  { name: "Net A", sport: "CRICKET" },
  { name: "Net B", sport: "CRICKET" },
];

export type Staff = Record<string, UserActor>;

export async function seedBase(joinDate: string): Promise<Staff> {
  await ensureDefaultSettings();
  await ensurePlans();
  for (const [i, c] of COURTS.entries()) {
    if (!(await prisma.court.findUnique({ where: { name: c.name } }))) await createCourt(SYSTEM, { ...c, sortOrder: i });
  }
  const staff: Staff = {};
  for (const s of STAFF_LOGINS) {
    let user = await prisma.user.findUnique({ where: { phone: s.phone }, include: { employee: true } });
    if (!user) {
      await createStaff(SYSTEM, { name: s.name, phone: s.phone, email: s.email, role: s.role, password: STAFF_PASSWORD, monthlySalary: s.salary, joinDate });
      user = await prisma.user.findUniqueOrThrow({ where: { phone: s.phone }, include: { employee: true } });
    }
    staff[s.email.split("@")[0]] = { kind: "USER", userId: user.id, role: s.role, name: s.name, memberId: null, employeeId: user.employee?.id ?? null };
  }
  return staff;
}
