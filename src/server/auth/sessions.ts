// DB-backed sessions (plan §1). The cookie holds a random token; the DB stores only its SHA-256.
import { createHash, randomBytes } from "node:crypto";
import { clock } from "@/lib/clock";
import { normalisePhone } from "@/lib/codes";
import { prisma, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Role } from "@prisma/client";
import type { UserActor } from "../rbac/actor";
import { verifyPassword } from "./password";

export const SESSION_COOKIE = "cc_session";
export const SESSION_DAYS = 7;

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Completion pass §6: where each role lands after logging in. */
export const ROLE_HOME: Record<Role, string> = {
  OWNER: "/app",
  MANAGER: "/app",
  FRONT_DESK: "/app/desk",
  SHOP_STAFF: "/app/shop",
  BAR_STAFF: "/app/bar",
  KITCHEN: "/app/bar/kds",
  ACCOUNTANT: "/app/finance/cash",
  MEMBER: "/portal",
};

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export function findUserByIdentifier(identifier: string) {
  const id = identifier.trim();
  return id.includes("@") ? prisma.user.findUnique({ where: { email: id.toLowerCase() } }) : prisma.user.findUnique({ where: { phone: normalisePhone(id) } });
}

/**
 * Log in (completion pass §6): MAX_FAILED_LOGINS wrong passwords lock the account for LOCK_MINUTES (RATE_LIMITED);
 * a success clears the counter and records the last login. Real time, not the business clock.
 */
export async function login(identifier: string, password: string) {
  const user = await findUserByIdentifier(identifier);
  const now = new Date();
  if (user?.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
    throw new DomainError("RATE_LIMITED", `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? "" : "s"}, or ask the club for a reset link.`, { retryAfterSeconds: mins * 60 });
  }
  if (!user || !user.active || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    if (user && user.active) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: failed >= MAX_FAILED_LOGINS ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) } : { failedLoginCount: failed },
      });
    }
    throw new DomainError("UNAUTHENTICATED", "Wrong phone/email or password.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt } });
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
  return { token, expiresAt, user: { id: user.id, name: user.name, role: user.role }, home: ROLE_HOME[user.role] };
}

/** Expire every session of a user except `keepToken` (password change, "log out everywhere"). */
export async function revokeSessions(userId: string, keepToken?: string) {
  await prisma.session.updateMany({
    where: { userId, expiresAt: { gt: new Date() }, ...(keepToken ? { NOT: { tokenHash: tokenHash(keepToken) } } : {}) },
    data: { expiresAt: new Date(0) },
  });
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  // Sessions are not transactional records; expiring them is the logout.
  await prisma.session.updateMany({ where: { tokenHash: tokenHash(token) }, data: { expiresAt: new Date(0) } });
}

/** Resolve a session token to an actor. Session expiry uses real time, not the business clock. */
export async function actorFromToken(token: string | undefined): Promise<UserActor | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: { include: { member: { select: { id: true } }, employee: { select: { id: true } } } } },
  });
  if (!session || session.expiresAt.getTime() < Date.now() || !session.user.active) return null;
  const u = session.user;
  return {
    kind: "USER",
    userId: u.id,
    role: u.role,
    name: u.name,
    memberId: u.member?.id ?? null,
    employeeId: u.employee?.id ?? null,
  };
}

/** One-time set-password link (MB-1), or a password-reset link (completion pass §6: 1 hour, RESET). */
export async function createPasswordSetToken(userId: string, tx?: Tx, opts: { purpose?: "SET" | "RESET"; createdBy?: string | null } = {}): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const purpose = opts.purpose ?? "SET";
  const ttl = purpose === "RESET" ? 60 * 60_000 : 7 * 86_400_000;
  await (tx ?? prisma).passwordSetToken.create({
    data: { userId, tokenHash: tokenHash(token), purpose, createdBy: opts.createdBy ?? null, expiresAt: new Date((purpose === "RESET" ? Date.now() : clock.now().getTime()) + ttl) },
  });
  return token;
}

/** Redeem a set-password link (MB-1). Single use, expires after 7 days. */
export async function redeemPasswordSetToken(token: string, password: string): Promise<void> {
  if (password.length < 8) throw new DomainError("VALIDATION_FAILED", "Password must be at least 8 characters.");
  const row = await prisma.passwordSetToken.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw new DomainError("VALIDATION_FAILED", "This link has expired or was already used. Ask the front desk for a new one.");
  }
  const { hashPassword } = await import("./password");
  const hash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: hash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } }),
    prisma.passwordSetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Every other link for this user stops working too.
    prisma.passwordSetToken.updateMany({ where: { userId: row.userId, usedAt: null, NOT: { id: row.id } }, data: { usedAt: new Date() } }),
  ]);
  // A reset logs the account out everywhere (someone else may have had the old password).
  if (row.purpose === "RESET") await revokeSessions(row.userId);
}
