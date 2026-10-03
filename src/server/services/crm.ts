// CRM, website enquiries and trials (plan §5.12 CR-1…CR-9; R-34…R-37; E-17).
import type { ActivityType, LeadSource, LeadStatus, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode, isIndianMobile, normalisePhone } from "@/lib/codes";
import { formatINR } from "@/lib/money";
import { addDays, addMonths, DAY, fmtDate, fmtDateTime, HOUR, istDate, istDayRange } from "@/lib/time";
import { nextSeq, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, PUBLIC, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { createBookingTx } from "./booking";
import { findOrCreateGuest } from "./guests";
import { notify, queueEmail } from "./notifications";
import { notifyMember } from "./channels";
import { assertCapability } from "./capabilities";
import { quoteManual, quoteMembership } from "./pricing";
import { getSettings } from "./settings";

const OPEN_STATUSES: LeadStatus[] = ["NEW", "CONTACTED", "QUOTED"];

// ───────────── v3 §8.2 lead assignment (LA-1…LA-4, LA-6) ─────────────

type Candidate = { id: string; name: string; email: string | null };
export type Assignment = Candidate & { reason: string };

/** A corporate / business-client enquiry (LA-1). */
const isCorporate = (interest: string) => /corporate|business|company|team event/i.test(interest);

/** Tie-break: fewest open leads, then longest since their last assignment, then name (deterministic). */
async function rank(tx: Tx, users: Candidate[]): Promise<Array<Candidate & { open: number }>> {
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const open = await tx.lead.groupBy({ by: ["assignedTo"], where: { assignedTo: { in: ids }, status: { in: OPEN_STATUSES } }, _count: { _all: true } });
  const last = await tx.lead.groupBy({ by: ["assignedTo"], where: { assignedTo: { in: ids } }, _max: { assignedAt: true } });
  const n = (id: string) => open.find((o) => o.assignedTo === id)?._count._all ?? 0;
  const t = (id: string) => last.find((o) => o.assignedTo === id)?._max.assignedAt?.getTime() ?? 0;
  return users.map((u) => ({ ...u, open: n(u.id) })).sort((a, b) => a.open - b.open || t(a.id) - t(b.id) || a.name.localeCompare(b.name));
}

const userSelect = { id: true, name: true, email: true } as const;
async function clockedIn(tx: Tx, role: "FRONT_DESK" | "MANAGER") {
  const open = await tx.attendance.findMany({ where: { clockOut: null }, select: { employeeId: true } });
  return tx.user.findMany({ where: { role, active: true, employee: { id: { in: open.map((a) => a.employeeId) }, active: true } }, select: userSelect });
}

/**
 * LA-1 corporate → a Manager on shift, else any Manager. LA-2 others → front desk clocked in with the fewest open
 * leads. LA-3 nobody clocked in → front desk rostered next (today/tomorrow). LA-4 → a Manager, else the Owner.
 * `exclude` leaves out a person (e.g. the one being deactivated).
 */
export async function chooseAssignee(tx: Tx, interest: string, exclude?: string): Promise<Assignment | null> {
  const not = (list: Candidate[]) => list.filter((u) => u.id !== exclude);
  const pick = async (list: Candidate[], why: (c: Candidate & { open: number }) => string) => {
    const [first] = await rank(tx, not(list));
    return first ? { id: first.id, name: first.name, email: first.email, reason: why(first) } : null;
  };
  const managers = await tx.user.findMany({ where: { role: "MANAGER", active: true }, select: userSelect });
  if (isCorporate(interest)) {
    const onShift = await pick(await clockedIn(tx, "MANAGER"), (c) => `LA-1: corporate enquiry → manager on shift, ${c.open} open leads`);
    if (onShift) return onShift;
    const any = await pick(managers, (c) => `LA-1: corporate enquiry → manager (none on shift), ${c.open} open leads`);
    if (any) return any;
  }
  const desk = await pick(await clockedIn(tx, "FRONT_DESK"), (c) => `LA-2: clocked in, ${c.open} open leads`);
  if (desk) return desk;
  const now = clock.now();
  const tomorrowEnd = istDayRange(addDays(istDate(now), 1))[1];
  const shifts = await tx.shift.findMany({
    where: { status: "ASSIGNED", endAt: { gt: now }, startAt: { lt: tomorrowEnd }, employeeId: { not: null } },
    orderBy: { startAt: "asc" }, select: { employeeId: true, startAt: true },
  });
  const deskEmployees = await tx.employee.findMany({ where: { id: { in: shifts.map((s) => s.employeeId!) }, active: true, user: { role: "FRONT_DESK", active: true } }, include: { user: { select: userSelect } } });
  const next = shifts.find((s) => deskEmployees.some((e) => e.id === s.employeeId && e.userId !== exclude));
  if (next) {
    const sameStart = shifts.filter((s) => s.startAt.getTime() === next.startAt.getTime()).map((s) => deskEmployees.find((e) => e.id === s.employeeId)?.user).filter((u): u is Candidate => !!u);
    const r = await pick(sameStart, (c) => `LA-3: nobody clocked in → next on the roster at ${fmtDateTime(next.startAt)}, ${c.open} open leads`);
    if (r) return r;
  }
  const mgr = await pick(managers, (c) => `LA-4: no front desk on the roster → manager, ${c.open} open leads`);
  if (mgr) return mgr;
  const owners = await tx.user.findMany({ where: { role: "OWNER", active: true }, select: userSelect });
  return pick(owners, () => "LA-4: no front desk or manager → owner");
}

/** LA-5: the assignee hears about it in the app and by push (if they turned it on). */
async function tellAssignee(tx: Tx, actor: Actor, lead: { id: string; code: string; name: string }, a: { id: string; reason: string }, key: string) {
  await notifyMember(tx, {
    event: "LEAD_ASSIGNED", userId: a.id, actor, channels: ["PUSH"], title: `Lead ${lead.code} assigned to you: ${lead.name}`,
    body: a.reason, link: `/app/crm/${lead.id}`, dedupeKey: key,
  });
}

export async function markLeadWon(tx: Tx, actor: Actor, leadId: string, memberId: string) {
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.status === "WON") return;
  await tx.lead.update({ where: { id: leadId }, data: { status: "WON", memberId } });
  await tx.leadActivity.create({ data: { leadId, type: "STATUS_CHANGE", note: "Membership paid — converted to member (WON)", byUserId: actorId(actor), at: clock.now() } });
  await audit(tx, actor, "lead.won", "lead", leadId, { before: { status: lead.status }, after: { status: "WON", memberId } });
}

// ───────────── leads (CR-1…CR-4) ─────────────

export const leadSchema = z.object({
  name: z.string().trim().min(2, "name is required").max(100),
  phone: z.string().optional().transform((p) => (p ? normalisePhone(p) : undefined)).refine((p) => !p || isIndianMobile(p), "must be a 10-digit Indian mobile number"),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  source: z.enum(["WEBSITE_ENQUIRY", "TRIAL_BOOKING", "WALK_IN", "PHONE", "REFERRAL"]).default("WEBSITE_ENQUIRY"),
  interest: z.string().trim().max(100).default(""),
  message: z.string().trim().max(2000).default(""),
});

/** Public forms (completion pass §7): an explicit consent tick (stored on the lead) and an empty honeypot field. */
export const publicFormSchema = z.object({
  consent: z.literal(true, { message: "Please agree to be contacted about your enquiry." }),
  website: z.string().max(0, "Please leave the last field empty.").optional(),
});

export async function createLeadTx(tx: Tx, actor: Actor, raw: z.input<typeof leadSchema>, extra: { guestId?: string; bookingId?: string; consentAt?: Date | null } = {}) {
  const input = leadSchema.parse(raw);
  if (!input.phone && !input.email) throw new DomainError("VALIDATION_FAILED", "Please give a phone number or an email so we can get back to you.");
  const s = await getSettings(tx);
  const now = clock.now();
  const assignee = await chooseAssignee(tx, input.interest);
  const code = formatCode("lead", await nextSeq(tx, CODE_SEQUENCE.lead));
  const lead = await tx.lead.create({
    data: {
      code, name: input.name, phone: input.phone ?? null, email: input.email ?? null, source: input.source as LeadSource,
      interest: input.interest, message: input.message, assignedTo: assignee?.id ?? null,
      assignmentReason: assignee?.reason ?? null, assignedAt: assignee ? now : null,
      nextFollowUpAt: new Date(now.getTime() + s.lead_follow_up_hours * HOUR), guestId: extra.guestId ?? null, bookingId: extra.bookingId ?? null,
      consentAt: extra.consentAt ?? null,
    },
  });
  await tx.leadActivity.create({
    data: { leadId: lead.id, type: "NOTE", note: `Lead created from ${input.source.replace(/_/g, " ").toLowerCase()}${input.message ? `: “${input.message.slice(0, 300)}”` : ""}`, byUserId: actorId(actor), at: now },
  });
  if (assignee) {
    await tx.leadActivity.create({ data: { leadId: lead.id, type: "ASSIGNED", note: `Assigned to ${assignee.name} — ${assignee.reason}`, byUserId: actorId(actor), at: now } });
    await tellAssignee(tx, actor, lead, assignee, `lead-assigned:${lead.id}:${assignee.id}:0`);
  }
  await audit(tx, actor, "lead.create", "lead", lead.id, { after: { code, name: lead.name, source: lead.source, assignedTo: assignee?.name ?? null } });
  // CR-3: every front desk and manager hears about it; the assignee also gets an email.
  await notify(tx, {
    roles: ["FRONT_DESK", "MANAGER"], type: "NEW_LEAD", title: `New lead ${code}: ${lead.name}`,
    body: `${input.source.replace(/_/g, " ").toLowerCase()}${input.interest ? ` · ${input.interest}` : ""} · assigned to ${assignee?.name ?? "nobody"} · follow up by ${fmtDateTime(lead.nextFollowUpAt)}`,
    link: `/app/crm/${lead.id}`, dedupeKey: `lead-new:${lead.id}`,
  });
  if (assignee?.email) {
    await queueEmail(tx, { to: assignee.email, subject: `New lead assigned: ${lead.name}`, body: `${code} · ${lead.phone ?? ""} ${lead.email ?? ""}\n${input.message}`, dedupeKey: `lead-assigned-email:${lead.id}` });
  }
  return lead;
}

/** R-36: website enquiries are captured and can't vanish. */
export async function createEnquiry(raw: z.input<typeof leadSchema> & z.input<typeof publicFormSchema>) {
  publicFormSchema.parse(raw);
  return withTx(async (tx) => {
    const lead = await createLeadTx(tx, PUBLIC, { ...raw, source: "WEBSITE_ENQUIRY" }, { consentAt: clock.now() });
    return { leadCode: lead.code };
  });
}

export async function createLead(actor: Actor, raw: z.input<typeof leadSchema>, outer?: Tx) {
  assertCan(actor, "crm");
  return withTx((tx) => createLeadTx(tx, actor, raw), outer);
}

async function getLeadOrThrow(tx: Tx | typeof prisma, leadId: string) {
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new DomainError("NOT_FOUND", "Lead was not found.");
  return lead;
}

export const activitySchema = z.object({
  type: z.enum(["CALL", "NOTE", "EMAIL"]),
  note: z.string().trim().min(2).max(2000),
  nextFollowUpAt: z.string().datetime({ offset: true }).optional(),
});

/** CR-5: activities with timestamp and staff member; contacting a NEW lead moves it to CONTACTED. */
export async function logActivity(actor: Actor, leadId: string, raw: z.infer<typeof activitySchema>, outer?: Tx) {
  assertCan(actor, "crm");
  const input = activitySchema.parse(raw);
  return withTx(async (tx) => {
    const lead = await getLeadOrThrow(tx, leadId);
    const now = clock.now();
    const s = await getSettings(tx);
    const next = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : new Date(now.getTime() + s.lead_follow_up_hours * HOUR);
    if (next.getTime() <= now.getTime() && OPEN_STATUSES.includes(lead.status)) throw new DomainError("VALIDATION_FAILED", "The next follow-up must be in the future.");
    await tx.leadActivity.create({ data: { leadId, type: input.type as ActivityType, note: input.note, byUserId: actorId(actor), at: now } });
    const status: LeadStatus = lead.status === "NEW" && input.type !== "NOTE" ? "CONTACTED" : lead.status;
    await tx.lead.update({ where: { id: leadId }, data: { status, nextFollowUpAt: next, overdueNotifiedAt: null } });
    await audit(tx, actor, "lead.activity", "lead", leadId, { after: { type: input.type, status, nextFollowUpAt: next } });
    return { leadId, status, nextFollowUpAt: next.toISOString() };
  }, outer);
}

/** LA-7: a Manager/Owner reassigns with a reason; audited; the old and the new assignee are told. */
export async function assignLead(actor: Actor, leadId: string, userId: string, reason: string) {
  assertCan(actor, "leads.assign");
  const why = z.string().trim().min(3, "Give a reason for the reassignment.").max(300).parse(reason);
  return withTx(async (tx) => {
    const lead = await getLeadOrThrow(tx, leadId);
    const u = await tx.user.findUnique({ where: { id: userId } });
    if (!u || !u.active || !["FRONT_DESK", "MANAGER", "OWNER"].includes(u.role)) throw new DomainError("VALIDATION_FAILED", "Leads can be assigned to front desk staff or managers.");
    const now = clock.now();
    const text = `LA-7: reassigned by ${actor.kind === "USER" ? actor.name : "the system"} — ${why}`;
    await tx.lead.update({ where: { id: leadId }, data: { assignedTo: userId, assignmentReason: text, assignedAt: now } });
    await tx.leadActivity.create({ data: { leadId, type: "ASSIGNED", note: `Assigned to ${u.name} — ${text}`, byUserId: actorId(actor), at: now } });
    await audit(tx, actor, "lead.assign", "lead", leadId, { before: { assignedTo: lead.assignedTo }, after: { assignedTo: userId }, reason: why });
    const n = await tx.leadActivity.count({ where: { leadId, type: "ASSIGNED" } });
    await tellAssignee(tx, actor, lead, { id: userId, reason: text }, `lead-assigned:${lead.id}:${userId}:${n}`);
    if (lead.assignedTo && lead.assignedTo !== userId) {
      await notify(tx, { userIds: [lead.assignedTo], type: "LEAD_REASSIGNED", title: `Lead ${lead.code} moved to ${u.name}`, body: why, link: `/app/crm/${lead.id}`, dedupeKey: `lead-reassigned:${lead.id}:${n}` });
    }
    return { leadId, assignedTo: userId };
  });
}

/** LA-7: when a user is deactivated, their open leads are reassigned by the same rules (inside that transaction). */
export async function reassignLeadsOf(tx: Tx, actor: Actor, userId: string) {
  const leads = await tx.lead.findMany({ where: { assignedTo: userId, status: { in: OPEN_STATUSES } }, orderBy: { createdAt: "asc" } });
  const gone = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  for (const lead of leads) {
    const a = await chooseAssignee(tx, lead.interest, userId);
    const now = clock.now();
    const text = a ? `LA-7: ${gone.name} was deactivated → ${a.reason}` : `LA-7: ${gone.name} was deactivated; nobody to assign to`;
    await tx.lead.update({ where: { id: lead.id }, data: { assignedTo: a?.id ?? null, assignmentReason: text, assignedAt: a ? now : null } });
    await tx.leadActivity.create({ data: { leadId: lead.id, type: "ASSIGNED", note: a ? `Assigned to ${a.name} — ${text}` : text, byUserId: actorId(actor), at: now } });
    await audit(tx, actor, "lead.assign", "lead", lead.id, { before: { assignedTo: userId }, after: { assignedTo: a?.id ?? null }, reason: text });
    if (a) await tellAssignee(tx, actor, lead, { id: a.id, reason: text }, `lead-assigned:${lead.id}:${a.id}:deactivated:${userId}`);
  }
  return { reassigned: leads.length };
}

/** CR-2: LOST needs a reason. WON comes from conversion (CR-7). */
export async function markLost(actor: Actor, leadId: string, reason: string) {
  assertCan(actor, "crm");
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "A reason is required to mark a lead as lost.");
  return withTx(async (tx) => {
    const lead = await getLeadOrThrow(tx, leadId);
    if (!OPEN_STATUSES.includes(lead.status)) throw new DomainError("ORDER_STATE_INVALID", `Lead ${lead.code} is already ${lead.status.toLowerCase()}.`);
    await tx.lead.update({ where: { id: leadId }, data: { status: "LOST", lostReason: reason } });
    await tx.leadActivity.create({ data: { leadId, type: "STATUS_CHANGE", note: `Marked lost: ${reason}`, byUserId: actorId(actor), at: clock.now() } });
    await audit(tx, actor, "lead.lost", "lead", leadId, { before: { status: lead.status }, after: { status: "LOST" }, reason });
    return { leadId, status: "LOST" as const };
  });
}

// ───────────── quotes (CR-6) ─────────────

export const quoteSchema = z.object({
  lines: z.array(z.union([
    z.object({ planCode: z.enum(["GOLD", "SILVER", "JUNIOR"]), months: z.union([z.literal(1), z.literal(3), z.literal(12)]) }),
    z.object({ description: z.string().trim().min(2).max(200), amount: z.number().int().min(0) }),
  ])).min(1).max(10),
  validDays: z.number().int().min(1).max(90).optional(),
  send: z.enum(["EMAIL", "LINK"]).default("LINK"),
});

export async function createQuote(actor: Actor, leadId: string, raw: z.input<typeof quoteSchema>, outer?: Tx) {
  assertCan(actor, "crm");
  const input = quoteSchema.parse(raw);
  return withTx(async (tx) => {
    const lead = await getLeadOrThrow(tx, leadId);
    if (!OPEN_STATUSES.includes(lead.status)) throw new DomainError("ORDER_STATE_INVALID", `Lead ${lead.code} is ${lead.status.toLowerCase()}.`);
    const s = await getSettings(tx);
    const today = istDate(clock.now());
    const lines = [];
    for (const l of input.lines) {
      if ("planCode" in l) {
        const plan = await tx.plan.findUniqueOrThrow({ where: { code: l.planCode } });
        const q = quoteMembership({ plan, months: l.months, startDate: today, endDate: addDays(addMonths(today, l.months), -1) }, s);
        lines.push({ kind: "PLAN", planCode: l.planCode, months: l.months, description: `${plan.name} membership · ${l.months} month${l.months > 1 ? "s" : ""}`, amount: q.total, explanation: q.lines[0].explanation });
      } else {
        const q = quoteManual([{ description: l.description, qty: 1, unitPrice: l.amount }], s);
        lines.push({ kind: "CUSTOM", description: l.description, amount: q.total, explanation: "Custom line" });
      }
    }
    if (input.send === "EMAIL") {
      await assertCapability("email");
      if (!lead.email) throw new DomainError("VALIDATION_FAILED", "This lead has no email address; share the link instead.");
    }
    const total = lines.reduce((a, l) => a + l.amount, 0);
    const token = randomBytes(16).toString("base64url");
    const validUntil = new Date(clock.now().getTime() + (input.validDays ?? s.quote_valid_days) * DAY);
    const quote = await tx.quote.create({ data: { leadId, token, lines: lines as unknown as Prisma.InputJsonValue, total, validUntil, createdBy: actorId(actor) } });
    const link = `${process.env.APP_URL ?? ""}/quote/${token}`;
    await tx.lead.update({ where: { id: leadId }, data: { status: "QUOTED", nextFollowUpAt: new Date(clock.now().getTime() + s.lead_follow_up_hours * HOUR), overdueNotifiedAt: null } });
    await tx.leadActivity.create({ data: { leadId, type: "QUOTE_SENT", note: `Quote for ${formatINR(total)} (valid until ${fmtDate(istDate(validUntil))}) ${input.send === "EMAIL" && lead.email ? `emailed to ${lead.email}` : "shared as a link"}: ${link}`, byUserId: actorId(actor), at: clock.now() } });
    if (input.send === "EMAIL" && lead.email) {
      await queueEmail(tx, { to: lead.email, subject: `Your quote from ${s.club.name}`, body: `Hi ${lead.name},\n\n${lines.map((l) => `• ${l.description}: ${formatINR(l.amount)}`).join("\n")}\nTotal: ${formatINR(total)}\nValid until ${fmtDate(istDate(validUntil))}.\n\nView and respond: ${link}`, dedupeKey: `quote:${quote.id}` });
    }
    await audit(tx, actor, "quote.create", "quote", quote.id, { after: { leadId, total, validUntil } });
    return { quoteId: quote.id, token, link: `/quote/${token}`, total, validUntil: validUntil.toISOString() };
  }, outer);
}

/** Public quote page data (no login). */
export async function getQuoteByToken(token: string) {
  const q = await prisma.quote.findUnique({ where: { token }, include: { lead: true } });
  if (!q) throw new DomainError("NOT_FOUND", "This quote link is not valid.");
  const expired = q.validUntil.getTime() < clock.now().getTime();
  const s = await getSettings();
  return {
    name: q.lead.name, lines: q.lines as Array<{ description: string; amount: number; explanation: string }>, total: q.total,
    validUntil: q.validUntil, expired, status: expired && q.status === "SENT" ? "EXPIRED" : q.status, club: { name: s.club.name, phone: s.club.phone, email: s.club.email },
  };
}

/** CR-6: "I'm interested" logs an activity and notifies the assignee (once). */
export async function markInterested(token: string) {
  return withTx(async (tx) => {
    const q = await tx.quote.findUnique({ where: { token }, include: { lead: true } });
    if (!q) throw new DomainError("NOT_FOUND", "This quote link is not valid.");
    if (q.validUntil.getTime() < clock.now().getTime()) throw new DomainError("ORDER_STATE_INVALID", "This quote has expired — please contact the club for a fresh one.");
    if (q.status === "INTERESTED") return { status: "INTERESTED" as const };
    await tx.quote.update({ where: { id: q.id }, data: { status: "INTERESTED" } });
    await tx.leadActivity.create({ data: { leadId: q.leadId, type: "INTERESTED", note: "Clicked “I'm interested” on the quote page", at: clock.now() } });
    await tx.lead.update({ where: { id: q.leadId }, data: { nextFollowUpAt: clock.now(), overdueNotifiedAt: null } });
    await audit(tx, PUBLIC, "quote.interested", "quote", q.id, { after: { status: "INTERESTED" } });
    await notify(tx, {
      userIds: q.lead.assignedTo ? [q.lead.assignedTo] : [], roles: ["MANAGER"], type: "QUOTE_INTEREST",
      title: `${q.lead.name} is interested in their quote`, body: `${q.lead.code} · ${formatINR(q.total)} — call them now to convert.`,
      link: `/app/crm/${q.leadId}`, dedupeKey: `quote-interest:${q.id}`, email: true,
    });
    return { status: "INTERESTED" as const };
  });
}

// ───────────── overdue follow-ups (CR-4, E-17) ─────────────

/** Job (every 5 minutes): notify once per overdue episode; the board flags overdue leads in red. */
export async function flagOverdueLeads(outer?: Tx) {
  return withTx(async (tx) => {
    const now = clock.now();
    const overdue = await tx.lead.findMany({ where: { status: { in: OPEN_STATUSES }, nextFollowUpAt: { lt: now }, overdueNotifiedAt: null } });
    for (const l of overdue) {
      await tx.lead.update({ where: { id: l.id }, data: { overdueNotifiedAt: now } });
      await notify(tx, {
        userIds: l.assignedTo ? [l.assignedTo] : [], roles: ["MANAGER"], type: "LEAD_OVERDUE",
        title: `Follow-up overdue: ${l.name} (${l.code})`, body: `Was due ${fmtDateTime(l.nextFollowUpAt)}.`,
        link: `/app/crm/${l.id}`, dedupeKey: `lead-overdue:${l.id}:${l.nextFollowUpAt.getTime()}`,
      });
    }
    // LA-8: still overdue `lead_escalation_hours` later → escalated to the Managers, once per lead.
    const s = await getSettings(tx);
    const late = await tx.lead.findMany({ where: { status: { in: OPEN_STATUSES }, nextFollowUpAt: { lt: new Date(now.getTime() - s.lead_escalation_hours * HOUR) }, escalatedAt: null } });
    const managers = await tx.user.findMany({ where: { role: "MANAGER", active: true }, select: { id: true } });
    for (const l of late) {
      await tx.lead.update({ where: { id: l.id }, data: { escalatedAt: now } });
      const who = l.assignedTo ? (await tx.user.findUnique({ where: { id: l.assignedTo }, select: { name: true } }))?.name : null;
      await tx.leadActivity.create({ data: { leadId: l.id, type: "NOTE", note: `LA-8: follow-up ${s.lead_escalation_hours}h overdue — escalated to the managers`, byUserId: null, at: now } });
      for (const m of managers) {
        await notifyMember(tx, {
          event: "LEAD_ESCALATED", userId: m.id, channels: ["PUSH"], title: `Escalated: ${l.name} (${l.code}) not followed up`,
          body: `Follow-up was due ${fmtDateTime(l.nextFollowUpAt)}${who ? `; assigned to ${who}` : "; unassigned"}.`, link: `/app/crm/${l.id}`, dedupeKey: `lead-escalated:${l.id}:${m.id}`,
        });
      }
    }
    return { flagged: overdue.length, escalated: late.length };
  }, outer);
}

// ───────────── trial booking (CR-8) ─────────────

export const trialSchema = publicFormSchema.extend({
  name: z.string().trim().min(2).max(100),
  phone: z.string().transform(normalisePhone).refine(isIndianMobile, "must be a 10-digit Indian mobile number"),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  courtId: z.string().min(1),
  date: z.string(),
  startTime: z.string(),
});

/** One trial per phone (TRIAL_ALREADY_USED); creates a guest, an ONLINE_TRIAL booking (all BK rules) and a lead. */
export async function createTrialBooking(raw: z.input<typeof trialSchema>) {
  const input = trialSchema.parse(raw);
  return withTx(async (tx) => {
    const member = await tx.member.findUnique({ where: { phone: input.phone } });
    if (member) throw new DomainError("TRIAL_ALREADY_USED", "This phone number already belongs to a member — log in to book a court.");
    const guest = await findOrCreateGuest(tx, { name: input.name, phone: input.phone, email: input.email ?? null });
    await tx.$queryRaw`SELECT id FROM guests WHERE id = ${guest.id} FOR UPDATE`;
    const used = await tx.booking.findFirst({ where: { primaryGuestId: guest.id, channel: "ONLINE_TRIAL", status: { notIn: ["CANCELLED", "CANCELLED_BY_CLUB"] } } });
    if (used) throw new DomainError("TRIAL_ALREADY_USED", `A trial was already booked with ${input.phone} (${used.bookingCode}). Each phone number gets one trial.`);
    const booking = await createBookingTx(tx, PUBLIC, {
      courtId: input.courtId, date: input.date, startTime: input.startTime, players: [{ guestId: guest.id }], channel: "ONLINE_TRIAL", payment: { kind: "LATER" },
    }, { trial: true });
    const lead = await createLeadTx(tx, PUBLIC, {
      name: input.name, phone: input.phone, email: input.email, source: "TRIAL_BOOKING", interest: "Trial session",
      message: `Trial booked: ${booking.court} ${fmtDateTime(booking.startAt)} (${booking.bookingCode})`,
    }, { guestId: guest.id, bookingId: booking.bookingId, consentAt: clock.now() });
    if (input.email) {
      await queueEmail(tx, { to: input.email, subject: `Trial confirmed: ${booking.court} ${fmtDateTime(booking.startAt)}`, body: `Hi ${input.name}, your trial ${booking.bookingCode} is booked. ${booking.total ? `The trial fee of ${formatINR(booking.total)} is paid at the desk.` : "The trial is free."} See you soon!`, dedupeKey: `trial:${booking.bookingId}` });
    }
    return { bookingCode: booking.bookingCode, court: booking.court, startAt: booking.startAt, endAt: booking.endAt, fee: booking.total, leadCode: lead.code };
  });
}

// ───────────── read side ─────────────

export async function listLeads(actor: Actor, q: { status?: string; mine?: boolean; search?: string } = {}) {
  assertCan(actor, "crm");
  const now = clock.now();
  const leads = await prisma.lead.findMany({
    where: {
      status: q.status ? (q.status as LeadStatus) : undefined,
      assignedTo: q.mine && actor.kind === "USER" ? actor.userId : undefined,
      OR: q.search ? [{ name: { contains: q.search, mode: "insensitive" } }, { phone: { contains: q.search } }, { code: { contains: q.search.toUpperCase() } }] : undefined,
    },
    orderBy: [{ nextFollowUpAt: "asc" }],
    take: 500,
  });
  const users = await prisma.user.findMany({ where: { id: { in: leads.map((l) => l.assignedTo).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return leads.map((l) => ({
    ...l,
    assignee: users.find((u) => u.id === l.assignedTo)?.name ?? null,
    overdue: OPEN_STATUSES.includes(l.status) && l.nextFollowUpAt.getTime() < now.getTime(),
  }));
}

export async function getLead(actor: Actor, leadId: string) {
  assertCan(actor, "crm");
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { activities: { orderBy: { at: "desc" } }, quotes: { orderBy: { createdAt: "desc" } } } });
  if (!lead) throw new DomainError("NOT_FOUND", "Lead was not found.");
  const userIds = [lead.assignedTo, ...lead.activities.map((a) => a.byUserId)].filter((x): x is string => !!x);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const staff = await prisma.user.findMany({ where: { role: { in: ["FRONT_DESK", "MANAGER"] }, active: true }, select: { id: true, name: true, role: true } });
  const now = clock.now();
  return {
    ...lead,
    assignee: users.find((u) => u.id === lead.assignedTo)?.name ?? null,
    overdue: OPEN_STATUSES.includes(lead.status) && lead.nextFollowUpAt.getTime() < now.getTime(),
    activities: lead.activities.map((a) => ({ ...a, by: a.byUserId ? (users.find((u) => u.id === a.byUserId)?.name ?? "staff") : "customer / system" })),
    quotes: lead.quotes.map((q) => ({ ...q, expired: q.validUntil.getTime() < now.getTime() })),
    // LA-7: only a Manager/Owner reassigns (with a reason); everyone sees why it went to whom (LA-6).
    assignable: can(actor, "leads.assign") ? staff : [],
    canReassign: can(actor, "leads.assign"),
    convertUrl: `/app/members/new?leadId=${lead.id}&name=${encodeURIComponent(lead.name)}&phone=${encodeURIComponent(lead.phone ?? "")}&email=${encodeURIComponent(lead.email ?? "")}`,
  };
}
