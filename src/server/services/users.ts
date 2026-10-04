// Users & roles (Settings → Users, plan §7). Staff users get an employee record (ST-1).
import type { Role } from "@prisma/client";
import { reassignLeadsOf } from "./crm";
import { z } from "zod";
import { email as emailField, mobilePhone, optionalContact } from "@/lib/validation/contact";
import { dbDate } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { hashPassword } from "../auth/password";
import { revokeSessions } from "../auth/sessions";
import { audit } from "./audit";
import { assertContactsAvailable, duplicateContactError } from "./contacts";

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(100),
  // v5 CV-1/CV-4: shared contact validators.
  phone: mobilePhone,
  email: optionalContact(emailField),
  role: z.enum(["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"]),
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
    // v5 CV-6: PHONE_/EMAIL_ALREADY_REGISTERED, naming the member when the number belongs to one.
    await assertContactsAvailable(tx, actor, { phone: input.phone, email: input.email });
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
      throw duplicateContactError(e, actor, { phone: input.phone, email: input.email }) ?? e;
    }
  }, outer);
}

export async function listUsers(actor: Actor) {
  assertCan(actor, "settings");
  // Never send password hashes or lockout internals to the browser.
  return prisma.user.findMany({
    where: { role: { not: "MEMBER" } },
    select: { id: true, name: true, phone: true, email: true, role: true, active: true, lastLoginAt: true, lockedUntil: true, createdAt: true, employee: true },
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
    // v3 LA-7: a deactivated person's open leads go to someone else by the assignment rules.
    if (!active) await reassignLeadsOf(tx, actor, userId);
    await audit(tx, actor, active ? "user.activate" : "user.deactivate", "user", userId, {
      before: { active: before.active },
      after: { active },
    });
    return user;
  });
}

// ───────── v4 §1.2 Employees (Owner): role, salary, join date, force logout ─────────

export const updateStaffSchema = z
  .object({
    role: z.enum(["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"]).optional(),
    monthlySalary: z.number().int().min(0).optional(),
    joinDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.role !== undefined || v.monthlySalary !== undefined || v.joinDate !== undefined, "Change the role, the salary or the join date.");

/** The Owner changes a staff member's role, salary or join date (each change audited with before/after). */
export async function updateStaff(actor: Actor, userId: string, raw: z.input<typeof updateStaffSchema>) {
  assertCan(actor, "users.manage");
  const input = updateStaffSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: userId }, include: { employee: true } });
    if (!before || before.role === "MEMBER") throw new DomainError("NOT_FOUND", "Staff member was not found.");
    if (input.role && input.role !== before.role && actor.kind === "USER" && actor.userId === userId) {
      throw new DomainError("VALIDATION_FAILED", "You cannot change your own role.");
    }
    if (input.role && input.role !== before.role) await tx.user.update({ where: { id: userId }, data: { role: input.role as Role } });
    if (input.monthlySalary !== undefined || input.joinDate !== undefined) {
      const data = { ...(input.monthlySalary !== undefined ? { monthlySalary: input.monthlySalary } : {}), ...(input.joinDate ? { joinDate: dbDate(input.joinDate) } : {}) };
      if (before.employee) await tx.employee.update({ where: { userId }, data });
      else await tx.employee.create({ data: { userId, monthlySalary: input.monthlySalary ?? 0, joinDate: dbDate(input.joinDate ?? new Date().toISOString().slice(0, 10)) } });
    }
    await audit(tx, actor, "user.update", "user", userId, {
      before: { role: before.role, monthlySalary: before.employee?.monthlySalary ?? null, joinDate: before.employee?.joinDate ?? null },
      after: { role: input.role ?? before.role, monthlySalary: input.monthlySalary ?? before.employee?.monthlySalary ?? null, joinDate: input.joinDate ?? before.employee?.joinDate ?? null },
    });
    return { id: userId, role: input.role ?? before.role };
  });
}

/** Force logout: every session of that person ends now (their next click asks them to log in again). */
export async function forceLogout(actor: Actor, userId: string) {
  assertCan(actor, "users.manage");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!u || u.role === "MEMBER") throw new DomainError("NOT_FOUND", "Staff member was not found.");
  if (actor.kind === "USER" && actor.userId === userId) throw new DomainError("VALIDATION_FAILED", "Use “Log out everywhere” in My account to end your own sessions.");
  const open = await prisma.session.count({ where: { userId, expiresAt: { gt: new Date() } } });
  await revokeSessions(userId);
  await audit(prisma, actor, "user.force_logout", "user", userId, { after: { sessionsEnded: open } });
  return { id: userId, sessionsEnded: open };
}
