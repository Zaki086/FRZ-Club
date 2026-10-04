// v5 §2.2 CV-6: one mobile number / one email per person. A phone or email already on another member or account is
// rejected with PHONE_ALREADY_REGISTERED / EMAIL_ALREADY_REGISTERED. Staff are told which member has it (the member
// code); members and the public only hear "already registered". Emails compare case-insensitively (CV-4).
// v5 names the codes for duplicates on create; an edit (profile, member details) keeps the existing VALIDATION_FAILED
// code with the same wording and `details.reason` = the v5 code.
import type { PrismaClient } from "@prisma/client";
import type { z, ZodType } from "zod";
import { pgConstraint, pgErrorCode, type Tx } from "../db";
import { DomainError } from "../errors";
import { isStaff, type Actor } from "../rbac/actor";

type Db = Tx | PrismaClient;
type Except = { userId?: string | null; memberId?: string | null };
type Owner = { memberCode: string | null };
type Mode = "create" | "edit";

async function phoneOwner(db: Db, phone: string, except: Except): Promise<Owner | null> {
  const m = await db.member.findFirst({ where: { phone, ...(except.memberId ? { NOT: { id: except.memberId } } : {}) }, select: { memberCode: true, userId: true } });
  if (m && !(except.userId && m.userId === except.userId)) return { memberCode: m.memberCode };
  const u = await db.user.findFirst({ where: { phone, ...(except.userId ? { NOT: { id: except.userId } } : {}) }, select: { member: { select: { id: true, memberCode: true } } } });
  if (u && !(except.memberId && u.member?.id === except.memberId)) return { memberCode: u.member?.memberCode ?? null };
  return null;
}

async function emailOwner(db: Db, email: string, except: Except): Promise<Owner | null> {
  // Exact lower(email) match (uses users_email_lower_key; no LIKE wildcards).
  const rows = await db.$queryRaw<Array<{ id: string; member_id: string | null; member_code: string | null }>>`
    SELECT u.id, m.id AS member_id, m.member_code FROM users u LEFT JOIN members m ON m.user_id = u.id
    WHERE lower(u.email) = ${email.toLowerCase()} AND u.id <> ${except.userId ?? ""}`;
  const u = rows.find((r) => !(except.memberId && r.member_id === except.memberId));
  return u ? { memberCode: u.member_code } : null;
}

function who(owner: Owner): string {
  return owner.memberCode ? `member ${owner.memberCode}` : "a staff account";
}

function taken(code: "PHONE_ALREADY_REGISTERED" | "EMAIL_ALREADY_REGISTERED", field: "phone" | "email", actor: Actor, value: string, owner: Owner | null, mode: Mode): DomainError {
  const asCode = mode === "create" ? code : "VALIDATION_FAILED";
  const reason = mode === "create" ? {} : { reason: code };
  if (!isStaff(actor) && actor.kind !== "SYSTEM") {
    return new DomainError(asCode, `This ${field === "phone" ? "mobile number" : "email address"} is already registered.`, { field, ...reason });
  }
  return new DomainError(asCode, `Someone is already registered with ${field} ${value}${owner ? ` — ${who(owner)}` : ""}.`, { field, memberCode: owner?.memberCode ?? null, ...reason });
}

export function phoneTaken(actor: Actor, phone: string, owner: Owner | null = null, mode: Mode = "create"): DomainError {
  return taken("PHONE_ALREADY_REGISTERED", "phone", actor, phone, owner, mode);
}

export function emailTaken(actor: Actor, email: string, owner: Owner | null = null, mode: Mode = "create"): DomainError {
  return taken("EMAIL_ALREADY_REGISTERED", "email", actor, email, owner, mode);
}

/** CV-6: throws PHONE_ALREADY_REGISTERED / EMAIL_ALREADY_REGISTERED when another person has the phone or the email. */
export async function assertContactsAvailable(db: Db, actor: Actor, c: { phone?: string | null; email?: string | null }, except: Except = {}, mode: Mode = "create") {
  if (c.phone) {
    const owner = await phoneOwner(db, c.phone, except);
    if (owner) throw phoneTaken(actor, c.phone, owner, mode);
  }
  if (c.email) {
    const owner = await emailOwner(db, c.email, except);
    if (owner) throw emailTaken(actor, c.email, owner, mode);
  }
}

/** A unique violation that slipped past the check (two desks at once) → the same codes, without the owner. */
export function duplicateContactError(e: unknown, actor: Actor, c: { phone?: string | null; email?: string | null }): DomainError | null {
  if (pgErrorCode(e) !== "23505") return null;
  const constraint = pgConstraint(e) ?? "";
  if (constraint.includes("email") && c.email) return emailTaken(actor, c.email);
  if (constraint.includes("phone") && c.phone) return phoneTaken(actor, c.phone);
  return null;
}

/**
 * Parse with Zod but fail as a DomainError VALIDATION_FAILED (422) naming the field — for services whose callers
 * (and tests) expect `code: "VALIDATION_FAILED"` where a lenient schema used to defer to a manual check.
 */
export function parseOrValidation<S extends ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  const field = i?.path?.map(String).join(".") ?? "";
  throw new DomainError("VALIDATION_FAILED", `Please check the form — ${field ? `${field}: ` : ""}${i?.message ?? "invalid input"}`, { field, issues: r.error.issues });
}
