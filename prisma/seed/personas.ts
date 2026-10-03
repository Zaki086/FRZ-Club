// Demo personas (§11.2): Rahul (Gold), Neha (Silver), Aarav (Junior, 15).
import { addDays, addMonths } from "@/lib/time";
import { prisma } from "@/server/db";
import type { UserActor } from "@/server/rbac/actor";
import { createMember } from "@/server/services/membership";
import { seedPasswords } from "./base";
import { tender } from "./proof";

export const PERSONAS = [
  { key: "rahul", name: "Rahul Mehta", phone: "9811000001", email: "rahul@example.com", dobYearsAgo: 34, plan: "GOLD" as const, months: 12 as const },
  { key: "neha", name: "Neha Kapoor", phone: "9811000002", email: "neha@example.com", dobYearsAgo: 29, plan: "SILVER" as const, months: 3 as const },
  { key: "aarav", name: "Aarav Shah", phone: "9811000003", email: "aarav.parent@example.com", dobYearsAgo: 15, plan: "JUNIOR" as const, months: 3 as const },
];

export async function seedPersonas(desk: UserActor, today: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const p of PERSONAS) {
    const existing = await prisma.member.findUnique({ where: { phone: p.phone } });
    if (existing) {
      ids[p.key] = existing.id;
      continue;
    }
    const dob = addDays(addMonths(today, -12 * p.dobYearsAgo), 40); // Aarav is 15 throughout the window
    const r = await createMember(desk, {
      name: p.name, phone: p.phone, email: p.email, dob, password: seedPasswords().member,
      emergencyContactName: "Family", emergencyContactPhone: "9822000000",
      // Aarav (15) has Rahul as his guardian: Rahul sees him under "Family" in the portal.
      ...(p.key === "aarav" ? { guardianName: "Rahul Mehta", guardianPhone: "9811000001" } : {}),
      plan: { code: p.plan, months: p.months, payment: tender("UPI") },
    });
    ids[p.key] = r.memberId;
  }
  return ids;
}
