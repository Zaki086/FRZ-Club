// Members & memberships (plan §5.1, §5.2 MB-1…MB-14; R-01…R-07).
import type { Bill, Membership, Plan, PlanCode } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode, isIndianMobile, normalisePhone } from "@/lib/codes";
import { formatINR, roundDiv } from "@/lib/money";
import { addDays, addMonths, ageOn, dbDate, diffDays, fmtDate, fromDbDate, istDate } from "@/lib/time";
import { nextSeq, pgConstraint, pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan, assertStaffOrSelf } from "../rbac/permissions";
import { hashPassword } from "../auth/password";
import { createPasswordSetToken, tokenHash } from "../auth/sessions";
import { audit } from "./audit";
import { closeBill, createBill } from "./bills";
import { idempotent } from "./idempotency";
import { issueMembershipInvoice } from "./invoices";
import { notify } from "./notifications";
import { recordPaymentTx } from "./payments";
import { createRequestedTx } from "./refund-records";
import { effectiveMembership, quoteMembership } from "./pricing";
import { getSettings } from "./settings";
import { guardianUserIds } from "./family";
import { notifyMember } from "./channels";

const today = () => istDate(clock.now());

// ───────────── sign-up (MB-1, R-01) ─────────────

const photoSchema = z
  .string()
  .max(300_000, "photo is too large (max ~200 KB)")
  .refine((s) => /^data:image\/(png|jpe?g|webp);base64,/.test(s) || /^https?:\/\//.test(s), "photo must be an image")
  .optional()
  .or(z.literal("").transform(() => undefined));

export const createMemberSchema = z.object({
  name: z.string().trim().min(2, "name is required").max(100),
  phone: z.string().transform(normalisePhone).refine(isIndianMobile, "must be a 10-digit Indian mobile number"),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date of birth is required"),
  photoUrl: photoSchema,
  emergencyContactName: z.string().trim().max(100).optional().or(z.literal("").transform(() => undefined)),
  emergencyContactPhone: z.string().trim().max(20).optional().or(z.literal("").transform(() => undefined)),
  leadId: z.string().optional(),
  // Completion pass P1: a guardian for members under 18 (required) — linked if the guardian is a member too.
  guardianName: z.string().trim().max(100).optional().or(z.literal("").transform(() => undefined)),
  guardianPhone: z.string().optional().or(z.literal("").transform(() => undefined)).transform((p) => (p ? normalisePhone(p) : undefined)).refine((p) => !p || isIndianMobile(p), "guardian's mobile must be a 10-digit Indian mobile number"),
  // DPDP: the member agreed to the club storing their details (ticked at the desk).
  consent: z.boolean().optional(),
  plan: z
    .object({
      code: z.enum(["GOLD", "SILVER", "JUNIOR"]),
      months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
      payment: z
        .object({
          method: z.enum(["CASH", "CARD", "UPI"]),
          reference: z.string().max(100).optional(),
          tendered: z.number().int().positive().optional(),
          cardLast4: z.string().max(4).optional(),
          approvalCode: z.string().max(20).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type CreateMemberInput = z.input<typeof createMemberSchema>;

/**
 * v3 §6.4 WK-1/WK-2: the desk captures identity only. The member's user record (username = phone) exists from
 * sign-up but has no password and no link, so nobody can log in until the first membership is paid — then the
 * one-time set-password link is issued (see issueFirstCredentialsTx). `internal.password` is for the sample-data
 * seed and test fixtures only; no route passes it.
 */
export async function createMemberTx(tx: Tx, actor: Actor, input: z.infer<typeof createMemberSchema>, internal: { password?: string } = {}) {
  const t = today();
  if (input.dob >= t) throw new DomainError("VALIDATION_FAILED", "Date of birth must be in the past.");
  if (ageOn(input.dob, t) > 110) throw new DomainError("VALIDATION_FAILED", "Please check the date of birth.");
  if (ageOn(input.dob, t) < 18 && !(input.guardianName && input.guardianPhone)) {
    throw new DomainError("VALIDATION_FAILED", "A guardian's name and mobile number are required for members under 18.");
  }
  if (input.guardianPhone && input.guardianPhone === input.phone) throw new DomainError("VALIDATION_FAILED", "The guardian's mobile must be different from the member's.");
  const guardian = input.guardianPhone ? await tx.member.findUnique({ where: { phone: input.guardianPhone }, select: { id: true } }) : null;
  const passwordHash = internal.password ? await hashPassword(internal.password) : null;
  let user;
  try {
    user = await tx.user.create({
      data: { name: input.name, phone: input.phone, email: input.email ?? null, passwordHash, role: "MEMBER", credentialsIssuedAt: passwordHash ? clock.now() : null },
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") {
      const field = (pgConstraint(e) ?? "").includes("email") ? `email ${input.email}` : `phone ${input.phone}`;
      throw new DomainError("VALIDATION_FAILED", `Someone is already registered with ${field}.`);
    }
    throw e;
  }
  const seq = await nextSeq(tx, CODE_SEQUENCE.member);
  const member = await tx.member.create({
    data: {
      userId: user.id,
      memberCode: formatCode("member", seq),
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      dob: dbDate(input.dob),
      photoUrl: input.photoUrl ?? null,
      emergencyContactName: input.emergencyContactName ?? null,
      emergencyContactPhone: input.emergencyContactPhone ?? null,
      leadId: input.leadId ?? null,
      guardianName: input.guardianName ?? null,
      guardianPhone: input.guardianPhone ?? null,
      guardianMemberId: guardian?.id ?? null,
      consentAt: input.consent ? clock.now() : null,
      createdBy: actorId(actor),
    },
  });
  await audit(tx, actor, "member.create", "member", member.id, {
    after: { code: member.memberCode, name: member.name, phone: member.phone },
  });
  return { member };
}

// ───────── v3 §6.4 walk-in credentials ─────────

/** Links issued inside a transaction, so the desk's success screen can show the QR right away (never stored raw). */
const issuedInTx = new WeakMap<Tx, Map<string, string>>();
export function credentialsIssuedIn(tx: Tx, memberId: string): string | null {
  return issuedInTx.get(tx)?.get(memberId) ?? null;
}

/** Guardian-managed Juniors under 13 get no login of their own (their guardian sees them under Family). */
function noOwnLogin(member: { dob: Date; guardianName: string | null }, onDate: string): boolean {
  return ageOn(fromDbDate(member.dob), onDate) < 13 && !!member.guardianName;
}

export const setPasswordUrl = (token: string) => `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/set-password/${token}`;

/**
 * WK-2/WK-3/WK-4: on the first paid membership, issue the one-time set-password link (no password is ever generated)
 * and send the welcome on every available channel. Returns the link, or null when no credentials are due.
 */
export async function issueFirstCredentialsTx(tx: Tx, actor: Actor, ms: { id: string; startDate: Date; endDate: Date; plan: { name: string }; member: { id: string; userId: string | null; name: string; memberCode: string; dob: Date; guardianName: string | null; phone: string } }) {
  if (!ms.member.userId) return null;
  const user = await tx.user.findUniqueOrThrow({ where: { id: ms.member.userId }, select: { passwordHash: true, credentialsIssuedAt: true } });
  if (user.passwordHash || user.credentialsIssuedAt) return null; // WK-7: existing logins are unchanged
  if (noOwnLogin(ms.member, today())) return null;
  const s = await getSettings(tx);
  const token = await createPasswordSetToken(ms.member.userId, tx, { ttlHours: s.credential_link_hours, createdBy: actorId(actor) });
  await tx.user.update({ where: { id: ms.member.userId }, data: { credentialsIssuedAt: clock.now() } });
  await audit(tx, actor, "member.credentials_issued", "member", ms.member.id, { after: { username: ms.member.phone, linkHours: s.credential_link_hours } });
  const map = issuedInTx.get(tx) ?? new Map<string, string>();
  map.set(ms.member.id, token);
  issuedInTx.set(tx, map);
  const link = setPasswordUrl(token);
  const start = fmtDate(fromDbDate(ms.startDate));
  const end = fmtDate(fromDbDate(ms.endDate));
  await notifyMember(tx, {
    event: "MEMBERSHIP_WELCOME", userId: ms.member.userId, memberId: ms.member.id, actor,
    title: `Welcome to ${s.club.name || "the club"}, ${ms.member.name.split(" ")[0]}`,
    body: [
      `${ms.plan.name} membership ${start} – ${end}. Member code ${ms.member.memberCode}.`,
      `Log in with your mobile number ${ms.member.phone}. Set your password (link works for ${s.credential_link_hours} hours, once): ${link}`,
      `Member portal and your member card: ${(process.env.APP_URL ?? "").replace(/\/$/, "")}/portal`,
    ].join("\n"),
    link: "/portal", dedupeKey: `membership-welcome:${ms.id}`,
    params: [ms.member.name, ms.plan.name, start, end, ms.member.memberCode, link],
  });
  return token;
}

/** WK-6: the desk issues a fresh link (the old ones stop working) and sends it again. */
export async function reissueCredentials(actor: Actor, memberId: string) {
  assertCan(actor, "password.links");
  return withTx(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!member?.userId) throw new DomainError("NOT_FOUND", "Member was not found.");
    if (noOwnLogin(member, today())) throw new DomainError("VALIDATION_FAILED", `${member.name} is under 13 and managed by their guardian, so has no login of their own.`);
    const paid = await tx.membership.count({ where: { memberId, status: { in: ["ACTIVE", "SCHEDULED", "EXPIRED"] } } });
    if (!paid) throw new DomainError("VALIDATION_FAILED", "The login is created when the first membership is paid.");
    const s = await getSettings(tx);
    await tx.passwordSetToken.updateMany({ where: { userId: member.userId, usedAt: null, purpose: "SET" }, data: { usedAt: clock.now() } });
    const token = await createPasswordSetToken(member.userId, tx, { ttlHours: s.credential_link_hours, createdBy: actorId(actor) });
    await tx.user.update({ where: { id: member.userId }, data: { credentialsIssuedAt: clock.now() } });
    const n = await tx.passwordSetToken.count({ where: { userId: member.userId, purpose: "SET" } });
    await audit(tx, actor, "member.credentials_reissued", "member", memberId, { after: { username: member.phone } });
    const link = setPasswordUrl(token);
    await notifyMember(tx, {
      event: "CREDENTIALS_REISSUED", userId: member.userId, memberId, actor,
      title: "Your new login link", body: `Log in with ${member.phone}. Set your password (link works for ${s.credential_link_hours} hours, once): ${link}`,
      link: "/login", dedupeKey: `credentials:${member.userId}:${n}`, params: [member.name, link],
    });
    return { token, link, username: member.phone, memberCode: member.memberCode, hours: s.credential_link_hours };
  });
}

/** WK-5 credentials panel: username, whether the member can log in, the link's state and how the welcome went out. */
export async function credentialsStatus(actor: Actor, memberId: string) {
  assertCan(actor, "members.view");
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member?.userId) throw new DomainError("NOT_FOUND", "Member was not found.");
  const [user, link, deliveries] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: member.userId }, select: { passwordHash: true, credentialsIssuedAt: true, lastLoginAt: true } }),
    prisma.passwordSetToken.findFirst({ where: { userId: member.userId, purpose: "SET", usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    prisma.notificationDelivery.findMany({ where: { memberId, event: { in: ["MEMBERSHIP_WELCOME", "CREDENTIALS_REISSUED"] } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const latestKey = deliveries[0]?.dedupeKey;
  return {
    username: member.phone, memberCode: member.memberCode,
    canLogIn: !!user.passwordHash, lastLoginAt: user.lastLoginAt, credentialsIssuedAt: user.credentialsIssuedAt,
    linkActiveUntil: link?.expiresAt ?? null,
    noOwnLogin: noOwnLogin(member, today()),
    deliveries: deliveries.filter((d) => d.dedupeKey === latestKey).map((d) => ({ id: d.id, channel: d.channel, status: d.status, error: d.error, at: d.sentAt ?? d.createdAt })),
  };
}

/** R-01: front-desk sign-up, optionally buying a plan and paying in the same transaction. */
export async function createMember(actor: Actor, raw: CreateMemberInput, idempotencyKey?: string | null, internal: { password?: string } = {}) {
  assertCan(actor, "members.manage");
  const input = createMemberSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "members.create", body: input }, async () => {
      const { member } = await createMemberTx(tx, actor, input, internal);
      let membership: Membership | null = null;
      let bill: Bill | null = null;
      if (input.plan) {
        const r = await purchaseTx(tx, actor, { memberId: member.id, planCode: input.plan.code, months: input.plan.months, kind: "NEW" });
        membership = r.membership;
        bill = r.bill;
        if (input.plan.payment && bill.total > 0) {
          await recordPaymentTx(tx, actor, { ...input.plan.payment, billId: bill.id, amount: bill.total });
          membership = await tx.membership.findUniqueOrThrow({ where: { id: membership.id } });
          bill = await tx.bill.findUniqueOrThrow({ where: { id: bill.id } });
        }
      }
      return {
        memberId: member.id,
        memberCode: member.memberCode,
        membershipId: membership?.id ?? null,
        membershipStatus: membership?.status ?? null,
        billId: bill?.id ?? null,
        billStatus: bill?.status ?? null,
        // WK-5: the one-time link issued on activation, for the QR on the desk's success screen (shown once).
        setPasswordToken: credentialsIssuedIn(tx, member.id),
      };
    }),
  );
}

export const updateMemberSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => null)).nullable(),
  photoUrl: photoSchema.nullable(),
  emergencyContactName: z.string().trim().max(100).optional().nullable(),
  emergencyContactPhone: z.string().trim().max(20).optional().nullable(),
});

export async function updateMember(actor: Actor, memberId: string, raw: z.infer<typeof updateMemberSchema>) {
  assertStaffOrSelf(actor, "members.manage", memberId);
  const input = updateMemberSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await tx.member.findUnique({ where: { id: memberId } });
    if (!before) throw new DomainError("NOT_FOUND", "Member was not found.");
    const member = await tx.member.update({
      where: { id: memberId },
      data: {
        name: input.name, email: input.email === undefined ? undefined : input.email,
        photoUrl: input.photoUrl === undefined ? undefined : input.photoUrl,
        emergencyContactName: input.emergencyContactName, emergencyContactPhone: input.emergencyContactPhone,
      },
    });
    if (member.userId) {
      await tx.user.update({ where: { id: member.userId }, data: { name: member.name, email: member.email } });
    }
    await audit(tx, actor, "member.update", "member", memberId, { before, after: member });
    return member;
  });
}

// ───────────── purchase / renew / upgrade / downgrade ─────────────

async function getMember(tx: Tx, memberId: string) {
  const m = await tx.member.findUnique({ where: { id: memberId } });
  if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
  return m;
}

async function planByCode(tx: Tx, code: PlanCode): Promise<Plan> {
  const p = await tx.plan.findUnique({ where: { code } });
  if (!p || !p.active) throw new DomainError("VALIDATION_FAILED", `The ${code} plan is not available.`);
  return p;
}

/** MB-2 / MB-12: Junior only if under 18 on the membership start date (IST). */
function assertJuniorAge(plan: Plan, dob: string, startDate: string, name: string) {
  if (plan.code !== "JUNIOR") return;
  const age = ageOn(dob, startDate);
  if (age >= 18) {
    throw new DomainError(
      "JUNIOR_AGE_INELIGIBLE",
      `${name} will be ${age} on ${fmtDate(startDate)}; the Junior plan is only for members under 18 on the start date.`,
      { age, startDate },
    );
  }
}

const endFor = (start: string, months: number) => addDays(addMonths(start, months), -1);

type PurchaseKind = "NEW" | "RENEWAL" | "UPGRADE";

/** Creates a PENDING_PAYMENT membership + its bill (MB-3). A ₹0 bill is paid immediately and activates. */
async function purchaseTx(
  tx: Tx,
  actor: Actor,
  input: { memberId: string; planCode: PlanCode; months: number; kind: PurchaseKind; startDate?: string; credit?: number; creditNote?: string; changedFromId?: string },
) {
  const member = await getMember(tx, input.memberId);
  // Serialise membership changes per member.
  await tx.$queryRaw`SELECT id FROM members WHERE id = ${member.id} FOR UPDATE`;
  const plan = await planByCode(tx, input.planCode);
  const t = today();
  const start = input.startDate ?? t;
  const end = endFor(start, input.months);
  assertJuniorAge(plan, fromDbDate(member.dob), start, member.name);

  const pending = await tx.membership.findFirst({ where: { memberId: member.id, status: "PENDING_PAYMENT" } });
  if (pending) {
    throw new DomainError(
      "MEMBERSHIP_CONFLICT",
      `${member.name} already has an unpaid membership waiting for payment. Take the payment or cancel it first.`,
      { membershipId: pending.id },
    );
  }
  if (input.kind === "NEW") {
    const current = await effectiveMembership(tx, member.id, t);
    const scheduled = await tx.membership.findFirst({ where: { memberId: member.id, status: "SCHEDULED" } });
    if (current || scheduled) {
      throw new DomainError(
        "MEMBERSHIP_CONFLICT",
        `${member.name} already has a ${current ? "current" : "scheduled"} membership; use Renew or Upgrade instead.`,
      );
    }
  }
  const s = await getSettings(tx);
  const quote = quoteMembership({ plan, months: input.months, credit: input.credit, creditNote: input.creditNote, startDate: start, endDate: end }, s);
  const membership = await tx.membership.create({
    data: {
      memberId: member.id, planId: plan.id, startDate: dbDate(start), endDate: dbDate(end), durationMonths: input.months,
      status: "PENDING_PAYMENT", price: quote.total, creditApplied: quote.discountTotal, changedFromId: input.changedFromId ?? null,
      kind: input.kind, createdBy: actorId(actor),
    },
  });
  let bill = await createBill(tx, {
    sourceType: "MEMBERSHIP", sourceId: membership.id,
    customer: { memberId: member.id, name: member.name }, tier: plan.code, lines: quote.lines, createdBy: actorId(actor),
  });
  await tx.membership.update({ where: { id: membership.id }, data: { billId: bill.id } });
  await audit(tx, actor, `membership.${input.kind.toLowerCase()}`, "membership", membership.id, {
    after: { plan: plan.code, months: input.months, start, end, price: quote.total, credit: quote.discountTotal },
  });
  if (bill.status === "PAID") {
    await onMembershipBillPaid(tx, bill, actor);
    bill = await tx.bill.findUniqueOrThrow({ where: { id: bill.id } });
  }
  return { membership: await tx.membership.findUniqueOrThrow({ where: { id: membership.id } }), bill, quote };
}

/** MB-3 / MB-7 / IN-4: when a membership bill is fully paid it becomes ACTIVE (or SCHEDULED) and is invoiced. */
export async function onMembershipBillPaid(tx: Tx, bill: Bill, actor: Actor) {
  const ms = await tx.membership.findFirst({ where: { billId: bill.id }, include: { plan: true, member: true } });
  if (!ms || ms.status !== "PENDING_PAYMENT") return;
  const t = today();
  const start = fromDbDate(ms.startDate);
  const end = fromDbDate(ms.endDate);
  if (ms.kind === "UPGRADE" && ms.changedFromId) {
    // MB-7: the old membership ends yesterday with status CHANGED; the upgrade takes effect today.
    const old = await tx.membership.findUniqueOrThrow({ where: { id: ms.changedFromId } });
    await tx.membership.update({ where: { id: old.id }, data: { status: "CHANGED", endDate: dbDate(addDays(t, -1)) } });
    await audit(tx, actor, "membership.changed", "membership", old.id, {
      before: { status: old.status, endDate: fromDbDate(old.endDate) },
      after: { status: "CHANGED", endDate: addDays(t, -1) },
    });
  }
  const status = end < t ? "EXPIRED" : start > t ? "SCHEDULED" : "ACTIVE";
  if (status === "ACTIVE") {
    // A previous membership that ended before today may still be stored ACTIVE until the daily job runs.
    await tx.membership.updateMany({
      where: { memberId: ms.memberId, status: "ACTIVE", endDate: { lt: dbDate(t) }, id: { not: ms.id } },
      data: { status: "EXPIRED" },
    });
  }
  try {
    await tx.membership.update({ where: { id: ms.id }, data: { status } });
  } catch (e) {
    if (pgErrorCode(e) === "23505") {
      throw new DomainError("MEMBERSHIP_CONFLICT", `${ms.member.name} already has an ${status.toLowerCase()} membership.`);
    }
    throw e;
  }
  if (ms.member.nextPlanId && ms.kind === "RENEWAL") {
    await tx.member.update({ where: { id: ms.memberId }, data: { nextPlanId: null, nextPlanMonths: null } });
  }
  await audit(tx, actor, "membership.activate", "membership", ms.id, { before: { status: "PENDING_PAYMENT" }, after: { status } });
  await issueMembershipInvoice(tx, actor, bill, ms.memberId);
  if (ms.member.leadId) {
    const { markLeadWon } = await import("./crm");
    await markLeadWon(tx, actor, ms.member.leadId, ms.memberId);
  }
  // WK-2/WK-4: the first paid membership issues the login link with the welcome; WK-7: otherwise a confirmation.
  const issued = await issueFirstCredentialsTx(tx, actor, ms);
  if (!issued && ms.member.userId) {
    await notifyMember(tx, {
      event: "MEMBERSHIP_RENEWED", userId: ms.member.userId, memberId: ms.member.id, actor,
      title: status === "SCHEDULED" ? `${ms.plan.name} renewal confirmed` : `${ms.plan.name} membership confirmed`,
      body: `${ms.plan.name} membership ${status === "SCHEDULED" ? "starts" : "active from"} ${fmtDate(start)} until ${fmtDate(end)}.`,
      link: "/portal/membership", dedupeKey: `membership-paid:${ms.id}`,
      params: [ms.member.name, ms.plan.name, fmtDate(start), fmtDate(end)],
    });
  }
}

export const purchaseSchema = z.object({
  memberId: z.string().min(1),
  planCode: z.enum(["GOLD", "SILVER", "JUNIOR"]),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** First membership (or a new one after a gap) for an existing member. */
export async function purchaseMembership(actor: Actor, raw: z.infer<typeof purchaseSchema>, idempotencyKey?: string | null) {
  assertCan(actor, "members.manage");
  const input = purchaseSchema.parse(raw);
  if (input.startDate && input.startDate < today()) throw new DomainError("VALIDATION_FAILED", "A membership cannot start in the past.");
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "membership.purchase", body: input }, async () => {
      const r = await purchaseTx(tx, actor, { ...input, kind: "NEW" });
      return { membershipId: r.membership.id, status: r.membership.status, billId: r.bill.id, total: r.bill.total };
    }),
  );
}

export const renewSchema = z.object({
  memberId: z.string().min(1),
  planCode: z.enum(["GOLD", "SILVER", "JUNIOR"]).optional(),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
});

/** MB-6: active → the new one starts end + 1 (SCHEDULED); expired → starts today. Uses a scheduled downgrade (MB-8). */
export async function renewMembership(actor: Actor, raw: z.infer<typeof renewSchema>, idempotencyKey?: string | null) {
  const input = renewSchema.parse(raw);
  assertStaffOrSelf(actor, "members.manage", input.memberId);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "membership.renew", body: input }, async () => {
      const member = await getMember(tx, input.memberId);
      const t = today();
      const scheduled = await tx.membership.findFirst({ where: { memberId: member.id, status: "SCHEDULED" } });
      if (scheduled) {
        throw new DomainError("MEMBERSHIP_CONFLICT", `${member.name} already has a renewal scheduled from ${fmtDate(fromDbDate(scheduled.startDate))}.`);
      }
      const current = await effectiveMembership(tx, member.id, t);
      const last = current ?? (await tx.membership.findFirst({
        where: { memberId: member.id, status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] } },
        include: { plan: { include: { courtFees: true } } },
        orderBy: { endDate: "desc" },
      }));
      if (!last) throw new DomainError("MEMBERSHIP_CONFLICT", `${member.name} has no membership to renew; buy a new one instead.`);
      const nextPlan = member.nextPlanId ? await tx.plan.findUnique({ where: { id: member.nextPlanId } }) : null;
      const planCode = input.planCode ?? nextPlan?.code ?? last.plan.code;
      const start = current ? addDays(fromDbDate(current.endDate), 1) : t;
      const r = await purchaseTx(tx, actor, { memberId: member.id, planCode, months: input.months, kind: "RENEWAL", startDate: start });
      return { membershipId: r.membership.id, status: r.membership.status, billId: r.bill.id, total: r.bill.total, startDate: start };
    }),
  );
}

export const upgradeSchema = z.object({
  memberId: z.string().min(1),
  planCode: z.enum(["GOLD", "SILVER", "JUNIOR"]),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
});

/** MB-7 credit: round(old_price_paid × remaining_days / total_days), remaining = old_end − today + 1. */
export function upgradeCredit(oldPrice: number, oldStart: string, oldEnd: string, onDate: string): { credit: number; remaining: number; total: number } {
  const total = diffDays(oldStart, oldEnd) + 1;
  const remaining = Math.max(0, diffDays(onDate, oldEnd) + 1);
  return { credit: total > 0 ? roundDiv(oldPrice * remaining, total) : 0, remaining, total };
}

export async function quoteUpgrade(actor: Actor, raw: z.infer<typeof upgradeSchema>) {
  const input = upgradeSchema.parse(raw);
  assertStaffOrSelf(actor, "members.manage", input.memberId);
  const t = today();
  const current = await effectiveMembership(prisma, input.memberId, t);
  if (!current) throw new DomainError("MEMBERSHIP_CONFLICT", "There is no active membership to upgrade.");
  const plan = await prisma.plan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new DomainError("NOT_FOUND", "Plan was not found.");
  const c = upgradeCredit(current.price, fromDbDate(current.startDate), fromDbDate(current.endDate), t);
  const s = await getSettings();
  return quoteMembership({ plan, months: input.months, credit: c.credit, creditNote: `credit for ${c.remaining} unused ${current.plan.name} days`, startDate: t, endDate: endFor(t, input.months) }, s);
}

export async function upgradeMembership(actor: Actor, raw: z.infer<typeof upgradeSchema>, idempotencyKey?: string | null) {
  const input = upgradeSchema.parse(raw);
  assertStaffOrSelf(actor, "members.manage", input.memberId);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "membership.upgrade", body: input }, async () => {
      const member = await getMember(tx, input.memberId);
      const t = today();
      const current = await effectiveMembership(tx, member.id, t);
      if (!current || current.status !== "ACTIVE") throw new DomainError("MEMBERSHIP_CONFLICT", `${member.name} has no active membership to upgrade.`);
      const target = await planByCode(tx, input.planCode);
      if (target.rank <= current.plan.rank) {
        throw new DomainError("MEMBERSHIP_CONFLICT", `${target.name} is not an upgrade from ${current.plan.name}. Downgrades take effect at the next renewal.`);
      }
      const scheduled = await tx.membership.findFirst({ where: { memberId: member.id, status: "SCHEDULED" } });
      if (scheduled) throw new DomainError("MEMBERSHIP_CONFLICT", `${member.name} has a renewal scheduled; cancel it before upgrading.`);
      const c = upgradeCredit(current.price, fromDbDate(current.startDate), fromDbDate(current.endDate), t);
      const r = await purchaseTx(tx, actor, {
        memberId: member.id, planCode: input.planCode, months: input.months, kind: "UPGRADE", startDate: t,
        credit: c.credit, creditNote: `credit for ${c.remaining} unused ${current.plan.name} days`, changedFromId: current.id,
      });
      return { membershipId: r.membership.id, status: r.membership.status, billId: r.bill.id, total: r.bill.total, credit: r.quote.discountTotal };
    }),
  );
}

export const downgradeSchema = z.object({
  memberId: z.string().min(1),
  planCode: z.enum(["GOLD", "SILVER", "JUNIOR"]),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
});

/** MB-8: downgrade is scheduled for the next renewal; the current membership runs to its end. No refunds. */
export async function scheduleDowngrade(actor: Actor, raw: z.infer<typeof downgradeSchema>) {
  assertCan(actor, "members.manage");
  const input = downgradeSchema.parse(raw);
  return withTx(async (tx) => {
    const member = await getMember(tx, input.memberId);
    const t = today();
    const current = await effectiveMembership(tx, member.id, t);
    if (!current) throw new DomainError("MEMBERSHIP_CONFLICT", `${member.name} has no current membership to downgrade.`);
    const target = await planByCode(tx, input.planCode);
    if (target.rank >= current.plan.rank) throw new DomainError("MEMBERSHIP_CONFLICT", `${target.name} is not a downgrade from ${current.plan.name}.`);
    const renewalStart = addDays(fromDbDate(current.endDate), 1);
    assertJuniorAge(target, fromDbDate(member.dob), renewalStart, member.name);
    await tx.member.update({ where: { id: member.id }, data: { nextPlanId: target.id, nextPlanMonths: input.months } });
    await audit(tx, actor, "membership.downgrade_scheduled", "member", member.id, {
      after: { nextPlan: target.code, months: input.months, from: renewalStart },
    });
    return { memberId: member.id, nextPlan: target.code, effectiveFrom: renewalStart };
  });
}

export const cancelMembershipSchema = z.object({
  membershipId: z.string().min(1),
  reason: z.string().trim().min(3, "a reason is required").max(300),
  refundAmount: z.number().int().min(0).optional(),
  refundMethod: z.enum(["CASH", "CARD", "UPI"]).optional(),
  refundReference: z.string().trim().max(100).optional(),
});

/**
 * MB-13: OWNER/MANAGER only, with a reason and an optional refund; audited. v3 RF-3: the refund is not a policy
 * refund, so it becomes a refund request that someone else approves (Manager up to the limit, Owner above) and
 * the desk then pays out. `refundMethod`/`refundReference` are accepted for older clients and ignored.
 */
export async function cancelMembership(actor: Actor, raw: z.infer<typeof cancelMembershipSchema>) {
  assertCan(actor, "membership.cancel");
  const input = cancelMembershipSchema.parse(raw);
  return withTx(async (tx) => {
    const ms = await tx.membership.findUnique({ where: { id: input.membershipId }, include: { member: true } });
    if (!ms) throw new DomainError("NOT_FOUND", "Membership was not found.");
    if (ms.status === "CANCELLED" || ms.status === "CHANGED") {
      throw new DomainError("CANCEL_NOT_ALLOWED", `This membership is already ${ms.status.toLowerCase()}.`);
    }
    let refundPending = 0;
    let refundRequest: { id: string; code: string } | null = null;
    if (input.refundAmount && ms.billId) {
      const r = await createRequestedTx(tx, actor, { billId: ms.billId, amount: input.refundAmount, reason: "OTHER", note: `Membership cancelled: ${input.reason}` });
      refundRequest = { id: r.id, code: r.code };
      refundPending = input.refundAmount;
    }
    if (ms.billId && ms.status === "PENDING_PAYMENT") await closeBill(tx, ms.billId, `Membership cancelled: ${input.reason}`, clock.now());
    const updated = await tx.membership.update({ where: { id: ms.id }, data: { status: "CANCELLED", cancelReason: input.reason } });
    await audit(tx, actor, "membership.cancel", "membership", ms.id, {
      before: { status: ms.status }, after: { status: "CANCELLED", refund: input.refundAmount ?? 0, refundPending }, reason: input.reason,
    });
    return { ...updated, refundPending, refundRequest };
  });
}

// ───────────── status, expiry job, reminders (MB-4, MB-11) ─────────────

export type EffectiveStatus = { tier: "GOLD" | "SILVER" | "JUNIOR" | "WALK_IN"; status: "ACTIVE" | "EXPIRED" | "NONE"; endDate: string | null; daysLeft: number | null; badge: "green" | "amber" | "red" | "neutral" };

/** MB-4/MB-10: always computed from dates and payment, never from a stale stored status. */
export async function effectiveStatus(memberId: string, onDate = today(), db: Tx | typeof prisma = prisma): Promise<EffectiveStatus> {
  const s = await getSettings(db as Tx);
  const m = await effectiveMembership(db, memberId, onDate);
  if (m) {
    const daysLeft = diffDays(onDate, fromDbDate(m.endDate));
    return { tier: m.plan.code, status: "ACTIVE", endDate: fromDbDate(m.endDate), daysLeft, badge: daysLeft <= s.expiring_soon_days ? "amber" : "green" };
  }
  const last = await db.membership.findFirst({
    where: { memberId, status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] }, endDate: { lt: dbDate(onDate) } },
    orderBy: { endDate: "desc" },
  });
  if (last) return { tier: "WALK_IN", status: "EXPIRED", endDate: fromDbDate(last.endDate), daysLeft: null, badge: "red" };
  return { tier: "WALK_IN", status: "NONE", endDate: null, daysLeft: null, badge: "neutral" };
}

/** Daily job (00:05 IST): persist transitions (MB-4) and send each reminder exactly once (MB-11). Idempotent. */
export async function runMembershipJob(outer?: Tx) {
  return withTx(async (tx) => {
    const t = today();
    const actor = { kind: "SYSTEM" as const, name: "membership-job" };
    // MB-4: ACTIVE past its end → EXPIRED.
    const toExpire = await tx.membership.findMany({ where: { status: "ACTIVE", endDate: { lt: dbDate(t) } } });
    for (const m of toExpire) {
      await tx.membership.update({ where: { id: m.id }, data: { status: "EXPIRED" } });
      await audit(tx, actor, "membership.expire", "membership", m.id, { before: { status: "ACTIVE" }, after: { status: "EXPIRED" } });
    }
    // SCHEDULED whose start has come → ACTIVE (after the previous one expired above).
    const toActivate = await tx.membership.findMany({ where: { status: "SCHEDULED", startDate: { lte: dbDate(t) } } });
    for (const m of toActivate) {
      const status = fromDbDate(m.endDate) < t ? "EXPIRED" : "ACTIVE";
      await tx.membership.update({ where: { id: m.id }, data: { status } });
      await audit(tx, actor, "membership.activate", "membership", m.id, { before: { status: "SCHEDULED" }, after: { status } });
    }
    // MB-11 reminders: 7 days before, 1 day before, and the day after expiry — each once (dedupe table).
    const candidates = await tx.membership.findMany({
      where: {
        status: { in: ["ACTIVE", "EXPIRED"] },
        endDate: { gte: dbDate(addDays(t, -30)), lte: dbDate(addDays(t, 7)) },
      },
      include: { member: true, plan: true },
    });
    let sent = 0;
    for (const m of candidates) {
      const end = fromDbDate(m.endDate);
      const daysLeft = diffDays(t, end);
      const type = daysLeft < 0 ? "EXPIRED" : daysLeft <= 1 ? "D1" : daysLeft <= 7 ? "D7" : null;
      if (!type) continue;
      if (type === "EXPIRED" && daysLeft < -30) continue;
      // Already renewed: no reminder needed.
      const follow = await tx.membership.findFirst({
        where: { memberId: m.memberId, id: { not: m.id }, status: { in: ["ACTIVE", "SCHEDULED"] }, endDate: { gt: dbDate(end) } },
      });
      if (follow) continue;
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO membership_reminders (id, membership_id, reminder_type, sent_at, updated_at)
        VALUES (${"rem_" + m.id + "_" + type}, ${m.id}, ${type}, ${clock.now()}, now())
        ON CONFLICT (membership_id, reminder_type) DO NOTHING RETURNING id`;
      if (!inserted.length) continue;
      sent++;
      const title =
        type === "EXPIRED" ? `${m.member.name}'s ${m.plan.name} membership has expired` : `${m.plan.name} membership expires ${type === "D1" ? "tomorrow" : `in ${daysLeft} days`}`;
      const body =
        type === "EXPIRED"
          ? `${m.member.name} (${m.member.memberCode}) expired on ${fmtDate(end)} and is now priced as a walk-in until renewed.`
          : `${m.member.name} (${m.member.memberCode}) · ${m.plan.name} ends ${fmtDate(end)}. Renew to keep member rates.`;
      if (m.member.userId) {
        // NT-1: every available channel, exactly once per membership + reminder + person + channel. Juniors'
        // guardians get the same reminder (completion pass P1).
        for (const userId of [m.member.userId, ...(await guardianUserIds([m.member.id]))]) {
          await notifyMember(tx, {
            event: "MEMBERSHIP_EXPIRY", userId, memberId: m.member.id, actor, title, body, link: "/portal/membership",
            dedupeKey: `membership-reminder:${m.id}:${type}:${userId}`, params: [m.member.name, m.plan.name, fmtDate(end)],
          });
        }
      }
      await notify(tx, {
        roles: ["FRONT_DESK"], type: "MEMBERSHIP_EXPIRY", title, body, link: `/app/members/${m.memberId}`,
        dedupeKey: `membership-reminder:${m.id}:${type}`,
      });
    }
    return { expired: toExpire.length, activated: toActivate.length, remindersSent: sent };
  }, outer);
}

/** Pay a membership bill at the desk (convenience wrapper used by renew/upgrade flows). */
export async function membershipPaymentSummary(membershipId: string) {
  const ms = await prisma.membership.findUnique({ where: { id: membershipId }, include: { plan: true } });
  if (!ms) throw new DomainError("NOT_FOUND", "Membership was not found.");
  const bill = ms.billId ? await prisma.bill.findUnique({ where: { id: ms.billId } }) : null;
  return { membership: ms, bill, label: `${ms.plan.name} · ${formatINR(ms.price)}` };
}

/** WK-5 welcome slip: the member's details and, only while it is valid and theirs, the set-password link. */
export async function welcomeSlip(actor: Actor, memberId: string, token: string | undefined) {
  assertCan(actor, "members.view");
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member?.userId) throw new DomainError("NOT_FOUND", "Member was not found.");
  const row = token ? await prisma.passwordSetToken.findUnique({ where: { tokenHash: tokenHash(token) } }) : null;
  const valid = !!row && row.userId === member.userId && !row.usedAt && row.expiresAt.getTime() > Date.now();
  return {
    name: member.name, memberCode: member.memberCode, username: member.phone,
    link: valid ? setPasswordUrl(token!) : null, linkExpiresAt: valid ? row!.expiresAt : null,
  };
}
