// Users & roles (Settings → Users, plan §7). Staff users get an employee record (ST-1).
import type { Role } from "@prisma/client";
import { z } from "zod";
import { isIndianMobile, normalisePhone } from "@/lib/codes";
import { dbDate } from "@/lib/time";
import { prisma, withTx, pgErrorCode, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { hashPassword } from "../auth/password";
import { audit } from "./audit";

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().transform(normalisePhone).refine(isIndianMobile, "must be a 10-digit Indian mobile number"),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  role: z.enum(["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT"]),
  password: z.string().min(8).max(100),
  monthlySalary: z.number().int().min(0),
  joinDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export async function createStaff(actor: Actor, raw: CreateStaffInput, outer?: Tx) {
  assertCan(actor, "settings");
  const input = createStaffSchema.parse(raw);
  const passwordHash = await hashPassword(input.password);
  return withTx(async (tx) => {
    try {
      const user = await tx.user.create({
        data: {
          name: input.name,
          phone: input.phone,
          email: input.email ?? null,
          passwordHash,
          role: input.role as Role,
        },
      });
      const employee = await tx.employee.create({
        data: { userId: user.id, monthlySalary: input.monthlySalary, joinDate: dbDate(input.joinDate) },
      });
      await audit(tx, actor, "user.create", "user", user.id, {
        after: { name: user.name, role: user.role, phone: user.phone, monthlySalary: input.monthlySalary },
      });
      return { user, employee };
    } catch (e) {
      if (pgErrorCode(e) === "23505") {
        throw new DomainError("VALIDATION_FAILED", `A user with phone ${input.phone} or that email already exists.`);
      }
      throw e;
    }
  }, outer);
}

export async function listUsers(actor: Actor) {
  assertCan(actor, "settings");
  return prisma.user.findMany({
    where: { role: { not: "MEMBER" } },
    include: { employee: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
}

export async function setUserActive(actor: Actor, userId: string, active: boolean) {
  assertCan(actor, "settings");
  return withTx(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: userId } });
    if (!before) throw new DomainError("NOT_FOUND", "User was not found.");
    if (actor.kind === "USER" && actor.userId === userId && !active) {
      throw new DomainError("VALIDATION_FAILED", "You cannot deactivate your own account.");
    }
    const user = await tx.user.update({ where: { id: userId }, data: { active } });
    await tx.employee.updateMany({ where: { userId }, data: { active } });
    await audit(tx, actor, active ? "user.activate" : "user.deactivate", "user", userId, {
      before: { active: before.active },
      after: { active },
    });
    return user;
  });
}
