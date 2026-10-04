// v5 §3.1–3.3: the record a message is about — who receives it, the values of its context's variables, its deep link
// (`{{link}}`), which ready-made templates fit it best right now, and the values an automatic WhatsApp template needs.
// Also the record search used to preview a template with a real record (MT-2).
import { Prisma } from "@prisma/client";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { fmtDate, fmtDateTime, fromDbDate, istDate } from "@/lib/time";
import { prisma } from "../../db";
import { DomainError } from "../../errors";
import type { Actor } from "../../rbac/actor";
import { assertCan, can } from "../../rbac/permissions";
import { billDue } from "../bills";
import { refundCollectToken } from "../refund-qr";
import { getSettings } from "../settings";
import { signResolutionToken } from "../signed-links";
import { isOptedIn } from "../whatsapp/config";
import { waAmount, waDate, waFirstName, waTime, type WaMessage } from "../whatsapp/templates";
import type { RecordOption, TemplateContext } from "./contract";
import type { AutoWhatsAppTemplate, RenderValues } from "./variables";

/** The person a message reaches, with everything channel availability depends on. */
export type Person = {
  kind: "MEMBER" | "GUEST" | "LEAD" | "CONTACT";
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  userId: string | null;
  memberId: string | null;
  guestId: string | null;
  leadId: string | null;
  /** The member's own channel switches (a person without a login: all on). */
  prefs: { push: boolean; email: boolean; whatsapp: boolean };
  /** Consent to automatic WhatsApp (v4 WA-30). */
  waOptIn: boolean;
  /** Replied STOP / withdrew WhatsApp consent (and didn't opt in again since). */
  waOptedOut: boolean;
  /** Unsubscribed from announcement emails (§3.2). */
  announcementsOptOut: boolean;
};

export type LoadedRecord = {
  context: TemplateContext;
  id: string;
  /** Short description for the log and audit ("Booking BK-0042"). */
  label: string;
  person: Person | null;
  /** The member behind the record (MEMBER templates can be sent from a booking, refund, order, tab or invoice). */
  memberId: string | null;
  /** This context's own variables (club.*, portal.url and link are added by the renderer). */
  values: RenderValues;
  /** Ready-made template keys that fit the record now, most relevant first. */
  hints: string[];
  /** Deep link (path or absolute URL) per template key (`*` = default); the button label comes from `linkLabel`. */
  links: Record<string, string | null>;
  /** Values for the automatic WhatsApp templates this record can fill. */
  wa: Partial<Record<AutoWhatsAppTemplate, WaMessage>>;
};

export const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");
export const absoluteUrl = (href: string) => (/^https?:\/\//.test(href) ? href : `${appUrl()}${href}`);

/** The record's deep link (absolute) for a template: its own link when it has one, else the context default. */
export function linkFor(rec: LoadedRecord, templateKey: string | null): string | null {
  const l = templateKey && templateKey in rec.links ? rec.links[templateKey] : rec.links["*"];
  return l ? absoluteUrl(l) : null;
}

const notFound = (what: string) => new DomainError("NOT_FOUND", `${what} was not found.`);
const optedOut = (r: { whatsappOptInAt: Date | null; whatsappOptOutAt: Date | null }) =>
  !!r.whatsappOptOutAt && (!r.whatsappOptInAt || r.whatsappOptInAt.getTime() <= r.whatsappOptOutAt.getTime());

// ───────── people ─────────

async function memberPerson(memberId: string | null | undefined): Promise<Person | null> {
  if (!memberId) return null;
  const m = await prisma.member.findUnique({ where: { id: memberId }, include: { user: { select: { id: true, active: true, notifyPush: true, notifyEmail: true, notifyWhatsapp: true } } } });
  if (!m || m.anonymisedAt) return null;
  const u = m.user && m.user.active ? m.user : null;
  return {
    kind: "MEMBER", id: m.id, name: m.name, phone: m.phone, email: m.email ?? null, userId: u?.id ?? null, memberId: m.id, guestId: null, leadId: null,
    prefs: { push: u?.notifyPush ?? true, email: u?.notifyEmail ?? true, whatsapp: u?.notifyWhatsapp ?? true },
    waOptIn: isOptedIn(m), waOptedOut: optedOut(m), announcementsOptOut: m.emailAnnouncementsOptOut,
  };
}

async function guestPerson(guestId: string | null | undefined): Promise<Person | null> {
  if (!guestId) return null;
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!g) return null;
  return {
    kind: "GUEST", id: g.id, name: g.name, phone: g.phone ?? null, email: g.email ?? null, userId: null, memberId: null, guestId: g.id, leadId: null,
    prefs: { push: false, email: true, whatsapp: true }, waOptIn: isOptedIn(g), waOptedOut: optedOut(g), announcementsOptOut: false,
  };
}

function leadPerson(l: { id: string; name: string; phone: string | null; email: string | null; whatsappOptInAt: Date | null; whatsappOptOutAt: Date | null; emailAnnouncementsOptOut: boolean }): Person {
  return {
    kind: "LEAD", id: l.id, name: l.name, phone: l.phone, email: l.email, userId: null, memberId: null, guestId: null, leadId: l.id,
    prefs: { push: false, email: true, whatsapp: true }, waOptIn: isOptedIn(l), waOptedOut: optedOut(l), announcementsOptOut: l.emailAnnouncementsOptOut,
  };
}

async function personOf(memberId: string | null | undefined, guestId: string | null | undefined) {
  return (await memberPerson(memberId)) ?? (await guestPerson(guestId));
}

const first = (p: Person | null) => waFirstName(p?.name);

// ───────── one loader per context ─────────

async function loadMember(id: string): Promise<LoadedRecord> {
  const m = await prisma.member.findFirst({ where: { OR: [{ id }, { memberCode: id }] }, select: { id: true, memberCode: true, name: true, createdAt: true } });
  if (!m) throw notFound("Member");
  const person = await memberPerson(m.id);
  const now = clock.now();
  const today = istDate(now);
  const [ms, bills, s] = await Promise.all([
    prisma.membership.findMany({ where: { memberId: m.id, status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] } }, include: { plan: { select: { name: true } } }, orderBy: { endDate: "desc" } }),
    prisma.bill.findMany({ where: { memberId: m.id, closedAt: null }, select: { total: true, amountPaid: true, amountRefunded: true, closedAt: true } }),
    getSettings(),
  ]);
  const day = (d: Date) => fromDbDate(d);
  const current = ms.find((x) => x.status === "ACTIVE" && day(x.startDate) <= today && day(x.endDate) >= today);
  const last = current ?? ms.find((x) => x.status !== "SCHEDULED" && day(x.endDate) < today);
  const lined = ms.some((x) => x.status === "SCHEDULED") || (await prisma.membership.count({ where: { memberId: m.id, status: "PENDING_PAYMENT" } })) > 0;
  const due = bills.reduce((a, b) => a + billDue(b), 0);
  const hints: string[] = [];
  if (!current && last && !lined) hints.push("membership_expired");
  if (current && !lined && day(current.endDate) <= addDaysStr(today, s.expiring_soon_days)) hints.push("membership_expiring");
  if (due > 0) hints.push("dues_reminder");
  if (now.getTime() - m.createdAt.getTime() < 14 * 86_400_000) hints.push("welcome_portal");
  const plan = last?.plan.name ?? "";
  const end = last ? fmtDate(day(last.endDate)) : "";
  const name = first(person);
  const wa: LoadedRecord["wa"] = {
    dues_reminder: { template: "dues_reminder", vars: { name, amount: waAmount(due), whatFor: "your club account" } },
  };
  if (last) {
    wa.membership_expiring = { template: "membership_expiring", vars: { name, plan, end: waDate(new Date(`${day(last.endDate)}T12:00:00+05:30`)) } };
    wa.membership_welcome = { template: "membership_welcome", vars: { name, plan, memberCode: m.memberCode, end: waDate(new Date(`${day(last.endDate)}T12:00:00+05:30`)) } };
  }
  return {
    context: "MEMBER", id: m.id, label: `Member ${m.memberCode}`, person, memberId: m.id,
    values: { "member.first_name": name, "member.code": m.memberCode, "membership.plan": plan, "membership.end_date": end, "dues.amount": formatINR(due) },
    hints,
    links: { "*": "/portal/membership", dues_reminder: "/portal/payments", welcome_portal: "/portal" },
    wa,
  };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function loadBooking(id: string): Promise<LoadedRecord> {
  const b = await prisma.booking.findFirst({ where: { OR: [{ id }, { bookingCode: id }] }, include: { reservation: { include: { court: { select: { name: true } } } } } });
  if (!b) throw notFound("Booking");
  const person = await personOf(b.primaryMemberId, b.primaryGuestId);
  const start = b.reservation.startAt;
  const end = b.reservation.endAt;
  const [bill, cc, movedHere] = await Promise.all([
    b.billId ? prisma.bill.findUnique({ where: { id: b.billId }, select: { total: true, amountPaid: true, amountRefunded: true, closedAt: true } }) : null,
    prisma.clubCancellation.findUnique({ where: { bookingId: b.id } }),
    prisma.clubCancellation.count({ where: { newBookingId: b.id } }),
  ]);
  const now = clock.now();
  const hints: string[] = [];
  if (b.status === "CANCELLED_BY_CLUB") hints.push("session_cancelled_by_club");
  if (b.status === "CANCELLED") hints.push("booking_cancelled");
  if (movedHere > 0) hints.push("reschedule_confirmed");
  if (bill && billDue(bill) > 0 && b.status === "CONFIRMED") hints.push("dues_reminder");
  if (b.status === "CONFIRMED" && start.getTime() > now.getTime()) hints.push("booking_reminder");
  const member = person?.kind === "MEMBER";
  const choice = cc && cc.status === "PENDING_CHOICE" && cc.deadlineAt.getTime() > now.getTime() ? `/r/${signResolutionToken(cc.id, cc.deadlineAt)}` : null;
  const view = member ? `/portal/bookings/${encodeURIComponent(b.bookingCode)}` : null;
  return {
    context: "BOOKING", id: b.id, label: `Booking ${b.bookingCode}`, person, memberId: b.primaryMemberId,
    values: {
      "member.first_name": first(person), "booking.code": b.bookingCode, "booking.court": b.reservation.court.name,
      "booking.date": waDate(start), "booking.time": `${waTime(start)}–${waTime(end)}`,
    },
    hints,
    links: { "*": choice ?? view, session_cancelled_by_club: choice ?? view, booking_cancelled: member ? "/portal/refunds" : null },
    wa: {
      booking_rescheduled: { template: "booking_rescheduled", vars: { name: first(person), court: b.reservation.court.name, time: waTime(start), date: waDate(start), booking: b.bookingCode }, button: { booking: b.bookingCode } },
    },
  };
}

async function loadRefund(id: string): Promise<LoadedRecord> {
  const r = await prisma.refundRequest.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (!r) throw notFound("Refund");
  const bill = await prisma.bill.findUnique({ where: { id: r.billId }, select: { memberId: true, guestId: true } });
  const person = await personOf(bill?.memberId, bill?.guestId);
  const ready = r.collectStatus === "READY_TO_COLLECT";
  const done = r.collectStatus === "COLLECTED" || r.status === "COMPLETED";
  const hints: string[] = [];
  if (ready) hints.push("refund_ready");
  if (done) hints.push("refund_collected");
  const member = person?.kind === "MEMBER";
  const qr = `/rq/${encodeURIComponent(refundCollectToken(r.id))}`;
  const link = ready ? qr : done && member ? `/portal/refunds/${r.id}/receipt` : member ? `/portal/refunds/${r.id}` : null;
  const name = first(person);
  const wa: LoadedRecord["wa"] = {};
  if (ready) wa.refund_ready_to_collect = { template: "refund_ready_to_collect", vars: { name, amount: waAmount(r.amount), ref: r.code }, button: { token: refundCollectToken(r.id) } };
  if (done) wa.refund_completed = { template: "refund_completed", vars: { name, amount: waAmount(r.amount), date: waDate(r.completedAt ?? clock.now()), ref: r.code } };
  return {
    context: "REFUND", id: r.id, label: `Refund ${r.code}`, person, memberId: bill?.memberId ?? null,
    values: { "member.first_name": name, "refund.code": r.code, "refund.amount": formatINR(r.amount) },
    hints,
    links: { "*": link, refund_ready: ready ? qr : link },
    wa,
  };
}

async function loadOrder(id: string): Promise<LoadedRecord> {
  const o = await prisma.shopOrder.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (o) {
    const person = await personOf(o.memberId, o.guestId);
    return {
      context: "ORDER", id: o.id, label: `Order ${o.code}`, person, memberId: o.memberId,
      values: { "member.first_name": first(person), "order.code": o.code },
      hints: o.status === "READY_FOR_PICKUP" ? ["order_ready"] : [],
      links: { "*": `/orders/${encodeURIComponent(o.trackToken)}` },
      wa: {},
    };
  }
  const t = await prisma.serviceTicket.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (!t) throw notFound("Order or restring ticket");
  const person = await personOf(t.memberId, t.guestId);
  return {
    context: "ORDER", id: t.id, label: `Restring ${t.code}`, person, memberId: t.memberId,
    values: { "member.first_name": first(person), "order.code": t.code },
    hints: ["restring_ready"],
    links: { "*": person?.kind === "MEMBER" ? "/portal/orders" : null },
    wa: {},
  };
}

async function loadTab(id: string): Promise<LoadedRecord> {
  const t = await prisma.tab.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (!t) throw notFound("Bar tab");
  const [bill, person] = await Promise.all([
    prisma.bill.findUnique({ where: { id: t.billId }, select: { total: true, amountPaid: true, amountRefunded: true, closedAt: true } }),
    personOf(t.memberId, t.guestId),
  ]);
  const open = t.status === "OPEN" || t.status === "CARRIED";
  const due = bill ? billDue(bill) : 0;
  return {
    context: "TAB", id: t.id, label: `Tab ${t.code}`, person, memberId: t.memberId,
    values: { "member.first_name": first(person), "tab.total": formatINR(open ? due : bill?.total ?? 0) },
    hints: open && due > 0 ? ["settle_tab"] : [],
    links: { "*": person?.kind === "MEMBER" ? "/portal/tab" : null },
    wa: {},
  };
}

async function loadLead(id: string): Promise<LoadedRecord> {
  const l = await prisma.lead.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (!l) throw notFound("Lead");
  const now = clock.now();
  const quote = await prisma.quote.findFirst({ where: { leadId: l.id, status: { in: ["SENT", "INTERESTED"] }, validUntil: { gt: now } }, orderBy: { createdAt: "desc" } });
  const hints: string[] = [];
  if (quote) hints.push("quote_follow_up");
  if (l.source === "TRIAL_BOOKING") hints.push("trial_follow_up");
  const plans = "/plans";
  return {
    context: "LEAD", id: l.id, label: `Lead ${l.code}`, person: leadPerson(l), memberId: null,
    values: { "lead.first_name": waFirstName(l.name) },
    hints,
    links: { "*": quote ? `/quote/${encodeURIComponent(quote.token)}` : plans, trial_follow_up: plans },
    wa: {},
  };
}

async function loadInvoice(id: string): Promise<LoadedRecord> {
  const inv = await prisma.invoice.findFirst({ where: { OR: [{ id }, { number: id }] } });
  if (!inv) throw notFound("Invoice");
  if (!inv.number) throw new DomainError("VALIDATION_FAILED", "This invoice is still a draft — issue it before messaging about it.");
  const [bill, member, client] = await Promise.all([
    prisma.bill.findUnique({ where: { id: inv.billId }, select: { total: true, amountPaid: true, amountRefunded: true, closedAt: true } }),
    memberPerson(inv.memberId),
    inv.businessClientId ? prisma.businessClient.findUnique({ where: { id: inv.businessClientId } }) : null,
  ]);
  const person: Person | null = member ?? (client
    ? {
        kind: "CONTACT", id: client.id, name: client.contactName, phone: client.contactPhone ?? null, email: client.contactEmail ?? null,
        userId: null, memberId: null, guestId: null, leadId: null, prefs: { push: false, email: true, whatsapp: true },
        waOptIn: false, waOptedOut: false, announcementsOptOut: false,
      }
    : null);
  return {
    context: "INVOICE", id: inv.id, label: `Invoice ${inv.number}`, person, memberId: inv.memberId,
    values: { "member.first_name": first(person), "invoice.number": inv.number, "invoice.due_date": inv.dueDate ? fmtDate(fromDbDate(inv.dueDate)) : "" },
    hints: bill && billDue(bill) > 0 && inv.status !== "CANCELLED" ? ["invoice_due"] : [],
    links: { "*": member ? `/portal/invoices/${inv.id}` : null },
    wa: {},
  };
}

/** GENERAL (announcements): a member (or a lead) — no personal variables, the portal (or the club's site) as link. */
function generalFrom(base: { id: string; label: string; person: Person | null }): LoadedRecord {
  const member = base.person?.kind === "MEMBER";
  return {
    context: "GENERAL", id: base.id, label: base.label, person: base.person, memberId: base.person?.memberId ?? null,
    values: {},
    hints: [],
    links: member ? { "*": "/portal", friday_social: "/portal/social" } : { "*": "/" },
    wa: {},
  };
}

async function loadGeneral(id: string): Promise<LoadedRecord> {
  const m = await prisma.member.findFirst({ where: { OR: [{ id }, { memberCode: id }] }, select: { id: true, memberCode: true } });
  if (m) return generalFrom({ id: m.id, label: `Member ${m.memberCode}`, person: await memberPerson(m.id) });
  const l = await prisma.lead.findFirst({ where: { OR: [{ id }, { code: id }] } });
  if (l) return generalFrom({ id: l.id, label: `Lead ${l.code}`, person: leadPerson(l) });
  throw notFound("Member or lead");
}

const LOADERS: Record<TemplateContext, (id: string) => Promise<LoadedRecord>> = {
  MEMBER: loadMember, BOOKING: loadBooking, REFUND: loadRefund, ORDER: loadOrder, TAB: loadTab, LEAD: loadLead, INVOICE: loadInvoice, GENERAL: loadGeneral,
};

/** The record of this context (by id, or by its code / number). */
export function loadRecord(context: TemplateContext, id: string): Promise<LoadedRecord> {
  return LOADERS[context](id);
}

/**
 * The record a template of `templateContext` uses when sent from a `recordContext` record: the record itself; for a
 * GENERAL template, the record's person; for a MEMBER template, the member behind a booking, refund, order, tab or
 * invoice (e.g. "Dues reminder" from an unpaid booking). Anything else doesn't fit.
 */
export async function recordForTemplate(templateContext: TemplateContext, recordContext: TemplateContext, id: string, base?: LoadedRecord): Promise<LoadedRecord> {
  if (templateContext === recordContext) return base ?? loadRecord(recordContext, id);
  const rec = base ?? (await loadRecord(recordContext, id));
  if (templateContext === "GENERAL") return generalFrom(rec);
  if (templateContext === "MEMBER" && rec.memberId) return loadMember(rec.memberId);
  throw new DomainError("VALIDATION_FAILED", `This template is for a ${templateContext.toLowerCase()}; it can't be sent from a ${recordContext.toLowerCase()}.`, { templateContext, recordContext });
}

/** Can a template of this context be sent from this record? (Without loading anything.) */
export function templateFits(templateContext: TemplateContext, rec: LoadedRecord): boolean {
  return templateContext === rec.context || templateContext === "GENERAL" || (templateContext === "MEMBER" && !!rec.memberId);
}

// ───────── MT-2: search real records to preview with ─────────

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function searchRecords(actor: Actor, input: { context: TemplateContext; q: string }): Promise<RecordOption[]> {
  if (!can(actor, "messages.templates.manage") && !can(actor, "messages.templates.view")) assertCan(actor, "messages.compose");
  const q = input.q.trim();
  const p = like(q);
  const any = q === "";
  const status = (s: string) => s.replace(/_/g, " ").toLowerCase();
  switch (input.context) {
    case "MEMBER": {
      const rows = await prisma.member.findMany({
        where: { anonymisedAt: null, ...(any ? {} : { OR: [{ name: { contains: q, mode: "insensitive" } }, { memberCode: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || q } }] }) },
        orderBy: any ? { updatedAt: "desc" } : { name: "asc" }, take: 10, select: { id: true, name: true, memberCode: true },
      });
      return rows.map((r) => ({ id: r.id, label: r.name, detail: r.memberCode }));
    }
    case "BOOKING": {
      const rows = await prisma.$queryRaw<{ id: string; code: string; who: string | null; court: string; start_at: Date; status: string }[]>`
        SELECT b.id, b.booking_code AS code, COALESCE(m.name, g.name) AS who, c.name AS court, r.start_at, b.status::text AS status
          FROM bookings b JOIN court_reservations r ON r.id = b.reservation_id JOIN courts c ON c.id = r.court_id
          LEFT JOIN members m ON m.id = b.primary_member_id LEFT JOIN guests g ON g.id = b.primary_guest_id
         WHERE ${any} OR b.booking_code ILIKE ${p} OR m.name ILIKE ${p} OR g.name ILIKE ${p}
         ORDER BY r.start_at DESC LIMIT 10`;
      return rows.map((r) => ({ id: r.id, label: `${r.code} · ${r.who ?? "—"}`, detail: `${r.court}, ${fmtDateTime(r.start_at)} · ${status(r.status)}` }));
    }
    case "REFUND": {
      const rows = await prisma.$queryRaw<{ id: string; code: string; who: string; amount: number; status: string; collect: string | null }[]>`
        SELECT r.id, r.code, b.customer_name AS who, r.amount, r.status, r.collect_status AS collect
          FROM refund_requests r JOIN bills b ON b.id = r.bill_id
         WHERE ${any} OR r.code ILIKE ${p} OR b.customer_name ILIKE ${p}
         ORDER BY r.created_at DESC LIMIT 10`;
      return rows.map((r) => ({ id: r.id, label: `${r.code} · ${r.who}`, detail: `${formatINR(r.amount)} · ${status(r.collect ?? r.status)}` }));
    }
    case "ORDER": {
      const rows = await prisma.$queryRaw<{ id: string; code: string; who: string; kind: string; status: string; at: Date }[]>`
        SELECT * FROM (
          SELECT o.id, o.code, b.customer_name AS who, 'Shop order' AS kind, o.status::text AS status, o.created_at AS at
            FROM shop_orders o JOIN bills b ON b.id = o.bill_id
           WHERE ${any} OR o.code ILIKE ${p} OR b.customer_name ILIKE ${p}
          UNION ALL
          SELECT t.id, t.code, t.customer_name AS who, 'Restring' AS kind, t.status::text AS status, t.created_at AS at
            FROM service_tickets t
           WHERE ${any} OR t.code ILIKE ${p} OR t.customer_name ILIKE ${p}) x
         ORDER BY at DESC LIMIT 10`;
      return rows.map((r) => ({ id: r.id, label: `${r.code} · ${r.who}`, detail: `${r.kind} · ${status(r.status)}` }));
    }
    case "TAB": {
      const rows = await prisma.$queryRaw<{ id: string; code: string; who: string; status: string; due: number }[]>`
        SELECT t.id, t.code, b.customer_name AS who, t.status::text AS status, GREATEST(0, b.total - (b.amount_paid - b.amount_refunded))::int AS due
          FROM tabs t JOIN bills b ON b.id = t.bill_id
         WHERE ${any} OR t.code ILIKE ${p} OR b.customer_name ILIKE ${p}
         ORDER BY t.created_at DESC LIMIT 10`;
      return rows.map((r) => ({ id: r.id, label: `${r.code} · ${r.who}`, detail: `${status(r.status)}${r.due ? ` · ${formatINR(r.due)} to settle` : ""}` }));
    }
    case "LEAD": {
      const rows = await prisma.lead.findMany({
        where: any ? {} : { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] },
        orderBy: { createdAt: "desc" }, take: 10, select: { id: true, name: true, code: true, status: true },
      });
      return rows.map((r) => ({ id: r.id, label: r.name, detail: `${r.code} · ${status(r.status)}` }));
    }
    case "INVOICE": {
      const rows = await prisma.$queryRaw<{ id: string; number: string; who: string; due_date: Date | null; status: string }[]>`
        SELECT i.id, i.number, b.customer_name AS who, i.due_date, i.status::text AS status
          FROM invoices i JOIN bills b ON b.id = i.bill_id
         WHERE i.number IS NOT NULL AND (${any} OR i.number ILIKE ${p} OR b.customer_name ILIKE ${p})
         ORDER BY i.issue_date DESC NULLS LAST, i.created_at DESC LIMIT 10`;
      return rows.map((r) => ({ id: r.id, label: `${r.number} · ${r.who}`, detail: `${r.due_date ? `due ${fmtDate(fromDbDate(r.due_date))} · ` : ""}${status(r.status)}` }));
    }
    case "GENERAL": {
      const rows = await prisma.$queryRaw<{ id: string; label: string; detail: string }[]>(Prisma.sql`
        SELECT * FROM (
          (SELECT m.id, m.name AS label, 'Member ' || m.member_code AS detail FROM members m
            WHERE m.anonymised_at IS NULL AND (${any} OR m.name ILIKE ${p} OR m.member_code ILIKE ${p}) ORDER BY m.name LIMIT 7)
          UNION ALL
          (SELECT l.id, l.name AS label, 'Lead ' || l.code AS detail FROM leads l
            WHERE ${any} OR l.name ILIKE ${p} OR l.code ILIKE ${p} ORDER BY l.created_at DESC LIMIT 3)) x`);
      return rows;
    }
  }
}
