// DB-backed sessions (plan §1). The cookie holds a random token; the DB stores only its SHA-256.
import { createHash, randomBytes } from "node:crypto";
import { clock } from "@/lib/clock";
import { normalisePhone } from "@/lib/codes";
import { prisma, type Tx } from "../db";
import { DomainError } from "../errors";
import type { UserActor } from "../rbac/actor";
import { verifyPassword } from "./password";

export const SESSION_COOKIE = "cc_session";
export const SESSION_DAYS = 7;

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function login(identifier: string, password: string) {
  const id = identifier.trim();
  const user = id.includes("@")
    ? await prisma.user.findUnique({ where: { email: id.toLowerCase() } })
    : await prisma.user.findUnique({ where: { phone: normalisePhone(id) } });
  if (!user || !user.active || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw new DomainError("UNAUTHENTICATED", "Wrong phone/email or password.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt } });
  return { token, expiresAt, user: { id: user.id, name: user.name, role: user.role } };
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

/** One-time set-password link for members created at the desk (MB-1). */
export async function createPasswordSetToken(userId: string, tx?: Tx): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await (tx ?? prisma).passwordSetToken.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt: new Date(clock.now().getTime() + 7 * 86_400_000) },
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
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: hash } }),
    prisma.passwordSetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
}
