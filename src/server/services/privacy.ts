// DPDP (completion pass P1). Members can download everything the club holds about them at any time, and ask for
// their personal data to be erased. The Owner decides erasure requests: personal details are replaced, while the
// transaction records (bills, payments, invoices, ledger) are kept as the law requires — with the name they carried.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { prisma, withTx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { revokeSessions } from "../auth/sessions";
import { audit } from "./audit";
import { billDue } from "./bills";
import { notify } from "./notifications";

function memberOf(actor: Actor): string {
  if (actor.kind !== "USER" || actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Not allowed: this is for members.");
  return actor.memberId;
}

/** Everything held about one member, as plain JSON. */
async function collect(memberId: string) {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });
  const [user, memberships, bookingPlayers, bills, invoices, tabs, orders, visits, socials, leads] = await Promise.all([
    member.userId ? prisma.user.findUnique({ where: { id: member.userId }, select: { name: true, phone: true, email: true, role: true, createdAt: true, lastLoginAt: true } }) : null,
    prisma.membership.findMany({ where: { memberId }, include: { plan: { select: { name: true } } }, orderBy: { startDate: "asc" } }),
    prisma.bookingPlayer.findMany({ where: { memberId }, include: { booking: { include: { reservation: { include: { court: { select: { name: true } } } } } } } }),
    prisma.bill.findMany({ where: { memberId }, include: { lines: true, payments: true }, orderBy: { createdAt: "asc" } }),
    prisma.invoice.findMany({ where: { memberId } }),
    prisma.tab.findMany({ where: { memberId } }),
    prisma.shopOrder.findMany({ where: { memberId }, include: { lines: true } }),
    prisma.visit.findMany({ where: { memberId } }),
    prisma.socialParticipant.findMany({ where: { memberId } }),
    prisma.lead.findMany({ where: { memberId } }),
  ]);
  const notifications = member.userId ? await prisma.notification.findMany({ where: { userId: member.userId }, orderBy: { createdAt: "asc" } }) : [];
  return {
    exportedAt: clock.now().toISOString(),
    profile: {
      memberCode: member.memberCode, name: member.name, phone: member.phone, email: member.email, dob: member.dob, photo: member.photoUrl ? "stored" : null,
      emergencyContact: { name: member.emergencyContactName, phone: member.emergencyContactPhone }, guardian: { name: member.guardianName, phone: member.guardianPhone },
      consentAt: member.consentAt, createdAt: member.createdAt,
    },
    login: user,
    memberships: memberships.map((m) => ({ plan: m.plan.name, status: m.status, startDate: m.startDate, endDate: m.endDate, cancelReason: m.cancelReason })),
    bookings: bookingPlayers.map((p) => ({ code: p.booking.bookingCode, court: p.booking.reservation.court.name, startAt: p.booking.reservation.startAt, status: p.booking.status, fee: p.feeSnapshot, checkedInAt: p.checkedInAt })),
    bills: bills.map((b) => ({
      id: b.id, source: b.sourceType, total: b.total, paid: b.amountPaid, refunded: b.amountRefunded, status: b.status, createdAt: b.createdAt,
      lines: b.lines.map((l) => ({ description: l.description, qty: l.qty, net: l.netAmount, tax: l.taxAmount, voided: !!l.voidedAt })),
      payments: b.payments.map((p) => ({ type: p.type, method: p.method, amount: p.amount, status: p.status, at: p.occurredAt })),
    })),
    invoices: invoices.map((i) => ({ number: i.number, status: i.status, issueDate: i.issueDate })),
    barTabs: tabs.map((t) => ({ code: t.code, status: t.status, createdAt: t.createdAt })),
    shopOrders: orders.map((o) => ({ code: o.code, status: o.status, fulfilment: o.fulfilment, address: o.address, createdAt: o.createdAt, lines: o.lines.length })),
    visits: visits.map((v) => ({ checkedInAt: v.checkedInAt })),
    socialPlay: socials.map((s) => ({ sessionId: s.sessionId, status: s.status })),
    enquiries: leads.map((l) => ({ code: l.code, source: l.source, interest: l.interest, message: l.message, createdAt: l.createdAt })),
    notifications: notifications.map((n) => ({ title: n.title, body: n.body, at: n.createdAt })),
  };
}

/** A member downloads their own data (also logged as a completed EXPORT request). */
export async function exportMyData(actor: Actor) {
  const memberId = memberOf(actor);
  const data = await collect(memberId);
  await prisma.dataRequest.create({ data: { memberId, kind: "EXPORT", status: "DONE", requestedBy: actorId(actor), handledBy: actorId(actor), handledAt: clock.now(), note: "Self-service download" } });
  await audit(prisma, actor, "privacy.export", "member", memberId, {});
  return data;
}

/** The Owner downloads a member's data (e.g. for a request made at the desk). */
export async function exportMemberData(actor: Actor, memberId: string) {
  assertCan(actor, "privacy.manage");
  const data = await collect(memberId);
  await audit(prisma, actor, "privacy.export", "member", memberId, {});
  return data;
}

export const erasureSchema = z.object({ note: z.string().trim().max(500).optional() });

export async function requestErasure(actor: Actor, raw: z.infer<typeof erasureSchema> = {}) {
  const memberId = memberOf(actor);
  const input = erasureSchema.parse(raw);
  const open = await prisma.dataRequest.findFirst({ where: { memberId, kind: "ERASE", status: "OPEN" } });
  if (open) return open;
  return withTx(async (tx) => {
    const r = await tx.dataRequest.create({ data: { memberId, kind: "ERASE", requestedBy: actorId(actor), note: input.note ?? null } });
    await audit(tx, actor, "privacy.erase_requested", "data_request", r.id, {});
    await notify(tx, { roles: ["OWNER"], type: "DATA_REQUEST", title: "Data erasure request", body: `A member asked for their personal data to be erased.`, link: "/app/settings/privacy", dedupeKey: `data-request:${r.id}` });
    return r;
  });
}

export async function myDataRequests(actor: Actor) {
  const memberId = memberOf(actor);
  return prisma.dataRequest.findMany({ where: { memberId }, orderBy: { createdAt: "desc" }, take: 20 });
}

export async function listDataRequests(actor: Actor) {
  assertCan(actor, "privacy.manage");
  const rows = await prisma.dataRequest.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 });
  const members = await prisma.member.findMany({ where: { id: { in: rows.map((r) => r.memberId) } }, select: { id: true, name: true, memberCode: true, anonymisedAt: true } });
  return rows.map((r) => ({ ...r, member: members.find((m) => m.id === r.memberId) ?? null }));
}

export const decideSchema = z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(500) });

/**
 * Decide an erasure request. Approval needs nothing outstanding (no amount due, no open tab, no upcoming booking,
 * no current membership); then name, contact details, date of birth, photo, guardian and emergency contact are
 * replaced, the login is closed and its sessions ended. Bills, payments and invoices are kept (tax law).
 */
export async function decideErasure(actor: Actor, requestId: string, raw: z.infer<typeof decideSchema>) {
  assertCan(actor, "privacy.manage");
  const input = decideSchema.parse(raw);
  return withTx(async (tx) => {
    const r = await tx.dataRequest.findUnique({ where: { id: requestId } });
    if (!r || r.kind !== "ERASE") throw new DomainError("NOT_FOUND", "Erasure request was not found.");
    if (r.status !== "OPEN") throw new DomainError("ORDER_STATE_INVALID", "This request was already decided.");
    const now = clock.now();
    if (!input.approve) {
      await tx.dataRequest.update({ where: { id: r.id }, data: { status: "REJECTED", handledBy: actorId(actor), handledAt: now, note: input.note } });
      await audit(tx, actor, "privacy.erase_rejected", "data_request", r.id, { reason: input.note });
      return { status: "REJECTED" as const };
    }
    const m = await tx.member.findUniqueOrThrow({ where: { id: r.memberId } });
    const bills = await tx.bill.findMany({ where: { memberId: m.id, closedAt: null } });
    const due = bills.reduce((a, b) => a + billDue(b), 0);
    const openTab = await tx.tab.count({ where: { memberId: m.id, status: { in: ["OPEN", "CARRIED"] } } });
    const upcoming = await tx.bookingPlayer.count({ where: { memberId: m.id, removedAt: null, booking: { status: "CONFIRMED", reservation: { endAt: { gt: now } } } } });
    const current = await tx.membership.count({ where: { memberId: m.id, status: { in: ["ACTIVE", "SCHEDULED", "PENDING_PAYMENT"] } } });
    const blockers = [due > 0 && "an amount still due", openTab && "an open bar tab", upcoming && "upcoming bookings", current && "a current membership (cancel it first)"].filter(Boolean);
    if (blockers.length) throw new DomainError("VALIDATION_FAILED", `Settle these first: ${blockers.join(", ")}.`);
    const erasedPhone = `erased-${m.memberCode}`;
    await tx.member.update({
      where: { id: m.id },
      data: { name: `Erased member ${m.memberCode}`, phone: erasedPhone, email: null, dob: new Date("1900-01-01T00:00:00Z"), photoUrl: null, emergencyContactName: null, emergencyContactPhone: null, guardianName: null, guardianPhone: null, guardianMemberId: null, anonymisedAt: now },
    });
    await tx.member.updateMany({ where: { guardianMemberId: m.id }, data: { guardianMemberId: null } });
    if (m.userId) await tx.user.update({ where: { id: m.userId }, data: { name: `Erased member ${m.memberCode}`, phone: erasedPhone, email: null, passwordHash: null, active: false } });
    await tx.lead.updateMany({ where: { memberId: m.id }, data: { name: `Erased member ${m.memberCode}`, phone: null, email: null, message: "" } });
    await tx.dataRequest.update({ where: { id: r.id }, data: { status: "DONE", handledBy: actorId(actor), handledAt: now, note: input.note } });
    await audit(tx, actor, "privacy.erased", "member", m.id, { reason: input.note });
    if (m.userId) await revokeSessions(m.userId);
    return { status: "DONE" as const };
  });
}
