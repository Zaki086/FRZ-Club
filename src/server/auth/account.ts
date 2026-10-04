// Account features for every role (completion pass §6): profile, change password (logs out other devices),
// forgotten password (email only when email really works — otherwise the club issues a link), staff-issued reset
// links, and "log out everywhere".
import { z } from "zod";
import { classifyLoginIdentifier, clearableContact, email as emailField, LOGIN_IDENTIFIER_MESSAGE, mobilePhone } from "@/lib/validation/contact";
import { prisma } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor, type UserActor } from "../rbac/actor";
import { assertUser, can } from "../rbac/permissions";
import { audit } from "../services/audit";
import { isEnabled } from "../services/capabilities";
import { queueEmail } from "../services/notifications";
import { getSettings } from "../services/settings";
import { assertContactsAvailable } from "../services/contacts";
import { hashPassword, verifyPassword } from "./password";
import { createPasswordSetToken, findUserByIdentifier, MEMBER_CODE_RE, revokeSessions, tokenHash } from "./sessions";
import { absoluteUrl } from "@/lib/url";

export async function getProfile(actor: Actor) {
  assertUser(actor);
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { id: true, name: true, phone: true, email: true, role: true, lastLoginAt: true, passwordChangedAt: true, createdAt: true, member: { select: { id: true, memberCode: true, emergencyContactName: true, emergencyContactPhone: true } } },
  });
  const activeSessions = await prisma.session.count({ where: { userId: actor.userId, expiresAt: { gt: new Date() } } });
  return { ...u, activeSessions };
}

export const profileSchema = z.object({
  // v5 CV-1/CV-4: blank clears the value.
  email: clearableContact(emailField),
  emergencyContactName: z.string().trim().max(80).optional(),
  emergencyContactPhone: clearableContact(mobilePhone),
});

/** Edit your own contact details. Name and phone (the login) are changed at the desk / by the Owner. */
export async function updateProfile(actor: Actor, raw: z.infer<typeof profileSchema>) {
  assertUser(actor);
  const input = profileSchema.parse(raw);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } });
  if (input.email !== undefined) {
    const email = input.email || null;
    // v5 CV-6: case-insensitive; a member only hears "already registered" (an edit keeps VALIDATION_FAILED).
    if (email) await assertContactsAvailable(prisma, actor, { email }, { userId: actor.userId, memberId: actor.memberId }, "edit");
    await prisma.user.update({ where: { id: actor.userId }, data: { email } });
    if (actor.memberId) await prisma.member.update({ where: { id: actor.memberId }, data: { email } });
  }
  if (actor.memberId && (input.emergencyContactName !== undefined || input.emergencyContactPhone !== undefined)) {
    const phone = input.emergencyContactPhone;
    await prisma.member.update({ where: { id: actor.memberId }, data: { emergencyContactName: input.emergencyContactName || null, emergencyContactPhone: phone || null } });
  }
  await audit(prisma, actor, "account.profile", "user", actor.userId, { before: { email: before.email }, after: { email: input.email ?? before.email } });
  return getProfile(actor);
}

export const changePasswordSchema = z.object({ current: z.string().min(1), next: z.string().min(8, "The new password must be at least 8 characters.").max(200) });

/** Change your password; every other device is logged out (the current one stays in). */
export async function changePassword(actor: Actor, currentToken: string | undefined, raw: z.infer<typeof changePasswordSchema>) {
  assertUser(actor);
  const input = changePasswordSchema.parse(raw);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!u.passwordHash || !(await verifyPassword(input.current, u.passwordHash))) throw new DomainError("VALIDATION_FAILED", "Your current password is not right.");
  if (input.current === input.next) throw new DomainError("VALIDATION_FAILED", "Choose a password different from the current one.");
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(input.next), passwordChangedAt: new Date() } });
  await revokeSessions(u.id, currentToken);
  await audit(prisma, actor, "account.password_change", "user", u.id, { after: { otherSessionsRevoked: true } });
  return { ok: true };
}

/** "Log out everywhere": every session, this one included. */
export async function logoutEverywhere(actor: Actor) {
  assertUser(actor);
  await revokeSessions(actor.userId);
  await audit(prisma, actor, "account.logout_all", "user", actor.userId, {});
  return { ok: true };
}

/** v5 CV-5: a mobile or an email (or a member code, v3 WK-2) — anything else is "Enter your registered mobile number or email." */
export const loginIdentifierField = z
  .string({ error: LOGIN_IDENTIFIER_MESSAGE })
  .trim()
  .max(254, LOGIN_IDENTIFIER_MESSAGE)
  .transform((v, ctx) => {
    const id = classifyLoginIdentifier(v);
    if (id) return id.value;
    if (MEMBER_CODE_RE.test(v)) return v;
    ctx.addIssue({ code: "custom", message: LOGIN_IDENTIFIER_MESSAGE });
    return z.NEVER;
  });

export const forgotSchema = z.object({ identifier: loginIdentifierField });

/**
 * Forgotten password. The answer never says whether an account exists. With working email the link is mailed;
 * without it the person is told to ask the club, which issues a link (createResetLink).
 */
export async function forgotPassword(raw: z.infer<typeof forgotSchema>) {
  const input = forgotSchema.parse(raw);
  const emailOn = await isEnabled("email");
  if (!emailOn) {
    return { emailed: false, message: "Ask the front desk (members) or the club owner (staff) for a password reset link." };
  }
  const user = await findUserByIdentifier(input.identifier);
  if (user?.active && user.email) {
    const token = await createPasswordSetToken(user.id, undefined, { purpose: "RESET" });
    const club = (await getSettings()).club.name || "the club";
    await prisma.$transaction(async (tx) => {
      await queueEmail(tx, {
        to: user.email!,
        subject: `Reset your ${club} password`,
        body: `Hi ${user.name},\n\nSomeone asked to reset your password. If it was you, choose a new one here (valid for 1 hour): ${absoluteUrl(`/set-password/${token}`)}\n\nIf it wasn't you, ignore this email.`,
        dedupeKey: `reset:${tokenHash(token)}`,
      });
    });
  }
  return { emailed: true, message: "If an account with an email address matches, a reset link is on its way (valid for 1 hour). No email? Ask the club for a link." };
}

/** The desk issues a member's link from the Member 360 (by member id). */
export async function createResetLinkForMember(actor: Actor, memberId: string) {
  const m = await prisma.member.findUnique({ where: { id: memberId }, select: { userId: true } });
  if (!m?.userId) throw new DomainError("NOT_FOUND", "This member has no login yet.");
  return createResetLink(actor, m.userId);
}

/**
 * Staff-issued reset link (capability password.links). Front desk: members only; Manager: members and staff below
 * Owner/Manager; Owner: anyone. The link is shown to the staff member to hand over (or send by WhatsApp).
 */
export async function createResetLink(actor: Actor, userId: string) {
  if (!can(actor, "password.links")) throw new DomainError("FORBIDDEN", "Not allowed: you cannot issue password links.");
  const staff = actor as UserActor;
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || !target.active) throw new DomainError("NOT_FOUND", "Account was not found.");
  const allowed =
    staff.role === "OWNER" ||
    (staff.role === "MANAGER" && !["OWNER", "MANAGER"].includes(target.role)) ||
    (staff.role === "FRONT_DESK" && target.role === "MEMBER");
  if (!allowed || target.id === staff.userId) throw new DomainError("FORBIDDEN", "Not allowed: you cannot issue a reset link for this account.");
  const token = await createPasswordSetToken(target.id, undefined, { purpose: "RESET", createdBy: actorId(actor) });
  await audit(prisma, actor, "account.reset_link", "user", target.id, { after: { for: target.name } });
  return { link: `/set-password/${token}`, url: absoluteUrl(`/set-password/${token}`), expiresInMinutes: 60, phone: target.phone, name: target.name };
}
