// Member lookup, Member 360, expiring list and dues (R-05, R-06, E-06, CI-1, MB-11).
import { clock } from "@/lib/clock";
import { normalisePhone } from "@/lib/codes";
import { memberCardPayload, qrDataUrl, verifyMemberCardPayload } from "@/lib/qr";
import { addDays, dbDate, fromDbDate, istDate, istDayRange } from "@/lib/time";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan, assertStaffOrSelf } from "../rbac/permissions";
import { billDue } from "./bills";
import { effectiveStatus } from "./membership";
import { getSettings } from "./settings";

/** R-05: search by name, phone or member code. */
export async function searchMembers(actor: Actor, q: string, limit = 20) {
  assertCan(actor, "members.lookup");
  const term = q.trim();
  if (term.length < 2) return [];
  const digits = normalisePhone(term);
  const members = await prisma.member.findMany({
    where: {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { memberCode: { contains: term.toUpperCase() } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    },
    orderBy: { name: "asc" },
    take: limit,
  });
  const t = istDate(clock.now());
  return Promise.all(
    members.map(async (m) => ({
      id: m.id, memberCode: m.memberCode, name: m.name, phone: m.phone, photoUrl: m.photoUrl,
      status: await effectiveStatus(m.id, t),
    })),
  );
}

/** MB-14: resolve a scanned member card. A tampered QR is rejected with INVALID_MEMBER_CARD. */
export async function lookupByCard(actor: Actor, payload: string) {
  assertCan(actor, "members.lookup");
  const memberId = verifyMemberCardPayload(payload);
  if (!memberId) throw new DomainError("INVALID_MEMBER_CARD", "This member card QR is not valid (it may have been altered). Search by name or phone instead.");
  const m = await prisma.member.findUnique({ where: { id: memberId } });
  if (!m) throw new DomainError("INVALID_MEMBER_CARD", "This member card does not belong to a current member.");
  return { memberId: m.id };
}

export async function memberCard(actor: Actor, memberId: string) {
  assertStaffOrSelf(actor, "members.view", memberId);
  const m = await prisma.member.findUnique({ where: { id: memberId } });
  if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
  const payload = memberCardPayload(m.id);
  return { memberCode: m.memberCode, name: m.name, photoUrl: m.photoUrl, payload, qr: await qrDataUrl(payload), status: await effectiveStatus(m.id) };
}

/** R-06 / E-06 / CI-1: everything the desk needs about one member. */
export async function member360(actor: Actor, memberId: string) {
  assertStaffOrSelf(actor, "members.view", memberId);
  const m = await prisma.member.findUnique({ where: { id: memberId }, include: { nextPlan: true } });
  if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
  const now = clock.now();
  const t = istDate(now);
  const [dayStart, dayEnd] = istDayRange(t);
  const [memberships, bookingPlayers, socials, visits, bills, tabs, card] = await Promise.all([
    prisma.membership.findMany({ where: { memberId }, include: { plan: true }, orderBy: { startDate: "desc" } }),
    prisma.bookingPlayer.findMany({
      where: { memberId, removedAt: null },
      include: { booking: { include: { reservation: { include: { court: true } }, players: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.socialParticipant.findMany({ where: { memberId }, include: { session: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.visit.findMany({ where: { memberId }, orderBy: { checkedInAt: "desc" }, take: 50 }),
    prisma.bill.findMany({ where: { memberId }, include: { lines: true }, orderBy: { createdAt: "desc" }, take: 500 }),
    prisma.tab.findMany({ where: { memberId }, orderBy: { createdAt: "desc" }, take: 50 }),
    memberCardPayload(memberId),
  ]);
  const status = await effectiveStatus(memberId, t);
  const bookings = bookingPlayers.map((bp) => ({
    id: bp.booking.id,
    code: bp.booking.bookingCode,
    court: bp.booking.reservation.court.name,
    startAt: bp.booking.reservation.startAt,
    endAt: bp.booking.reservation.endAt,
    status: bp.booking.status,
    isPrimary: bp.booking.primaryMemberId === memberId,
    fee: bp.feeSnapshot,
    tier: bp.tierSnapshot,
    playerId: bp.id,
    checkedInAt: bp.checkedInAt,
    billId: bp.booking.billId,
  }));
  const todays = bookings
    .filter((b) => b.startAt >= dayStart && b.startAt < dayEnd && b.status !== "CANCELLED")
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const todaySocial = socials
    .filter((s) => s.status === "JOINED" && s.session.startAt >= dayStart && s.session.startAt < dayEnd)
    .map((s) => ({ id: s.id, title: s.session.title, startAt: s.session.startAt, endAt: s.session.endAt, checkedInAt: s.checkedInAt, billId: s.billId }));
  const sumBy = (types: string[]) => bills.filter((b) => types.includes(b.sourceType)).reduce((a, b) => a + (b.amountPaid - b.amountRefunded), 0);
  const discountsSaved = bills.filter((b) => !b.closedAt).reduce((a, b) => a + b.discountTotal, 0);
  const dues = bills.filter((b) => billDue(b) > 0).map((b) => ({ id: b.id, sourceType: b.sourceType, due: billDue(b), createdAt: b.createdAt, description: b.lines[0]?.description ?? b.sourceType }));
  const openTab = tabs.find((x) => x.status === "OPEN") ?? null;
  const openTabBill = openTab ? bills.find((b) => b.id === openTab.billId) : null;
  return {
    member: { ...m, dob: fromDbDate(m.dob) },
    status,
    cardPayload: card,
    memberships: memberships.map((x) => ({ ...x, startDate: fromDbDate(x.startDate), endDate: fromDbDate(x.endDate) })),
    nextPlan: m.nextPlan ? { code: m.nextPlan.code, name: m.nextPlan.name, months: m.nextPlanMonths } : null,
    today: { bookings: todays, social: todaySocial },
    bookings: bookings.slice(0, 100),
    social: socials.map((s) => ({ id: s.id, title: s.session.title, startAt: s.session.startAt, status: s.status, fee: s.feeSnapshot })),
    visits,
    lastVisit: visits[0]?.checkedInAt ?? null,
    purchases: bills.filter((b) => ["COUNTER_SALE", "SHOP_ORDER", "SERVICE_TICKET"].includes(b.sourceType)).slice(0, 50),
    tabs: tabs.map((x) => ({ ...x, total: bills.find((b) => b.id === x.billId)?.total ?? 0, due: (() => { const b = bills.find((y) => y.id === x.billId); return b ? billDue(b) : 0; })() })),
    openTab: openTab ? { id: openTab.id, code: openTab.code, total: openTabBill?.total ?? 0, due: openTabBill ? billDue(openTabBill) : 0 } : null,
    payments: await prisma.payment.findMany({ where: { bill: { memberId } }, orderBy: { occurredAt: "desc" }, take: 100 }),
    dues,
    totals: {
      bookings: bookings.length,
      courtSpend: sumBy(["BOOKING", "SOCIAL_JOIN"]),
      shopSpend: sumBy(["COUNTER_SALE", "SHOP_ORDER", "SERVICE_TICKET"]),
      barSpend: sumBy(["BAR_TAB"]),
      membershipSpend: sumBy(["MEMBERSHIP"]),
      discountsSaved,
      visits: visits.length,
      dueTotal: dues.reduce((a, d) => a + d.due, 0),
    },
  };
}

/** MB-11: the front desk "Expiring in 7 days" list (and recently expired). */
export async function listExpiring(actor: Actor) {
  assertCan(actor, "members.view");
  const s = await getSettings();
  const t = istDate(clock.now());
  const rows = await prisma.membership.findMany({
    where: {
      status: { in: ["ACTIVE", "EXPIRED"] },
      endDate: { gte: dbDate(addDays(t, -14)), lte: dbDate(addDays(t, s.expiring_soon_days)) },
    },
    include: { member: true, plan: true },
    orderBy: { endDate: "asc" },
  });
  const out = [];
  for (const r of rows) {
    const renewed = await prisma.membership.findFirst({
      where: { memberId: r.memberId, id: { not: r.id }, status: { in: ["ACTIVE", "SCHEDULED"] }, endDate: { gt: r.endDate } },
    });
    if (renewed) continue;
    const end = fromDbDate(r.endDate);
    out.push({ membershipId: r.id, memberId: r.memberId, memberCode: r.member.memberCode, name: r.member.name, phone: r.member.phone, plan: r.plan.code, endDate: end, expired: end < t });
  }
  return out;
}

/** "What we are owed" from members: unpaid customer bills (member dues). */
export async function listDues(actor: Actor) {
  assertCan(actor, "members.view");
  const bills = await prisma.bill.findMany({
    where: { closedAt: null, status: { in: ["UNPAID", "PARTIAL", "PARTIALLY_REFUNDED"] }, sourceType: { not: "INVOICE" } },
    include: { lines: { take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return bills
    .filter((b) => billDue(b) > 0 && (b.memberId || b.guestId))
    .map((b) => ({ billId: b.id, customer: b.customerName, memberId: b.memberId, sourceType: b.sourceType, due: billDue(b), createdAt: b.createdAt, description: b.lines[0]?.description ?? "" }));
}

export async function listMembers(actor: Actor, opts: { tier?: string; status?: string; take?: number } = {}) {
  assertCan(actor, "members.view");
  const members = await prisma.member.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(opts.take ?? 300, 1000) });
  const t = istDate(clock.now());
  const rows = await Promise.all(members.map(async (m) => ({ id: m.id, memberCode: m.memberCode, name: m.name, phone: m.phone, createdAt: m.createdAt, status: await effectiveStatus(m.id, t) })));
  return rows.filter((r) => (!opts.tier || r.status.tier === opts.tier) && (!opts.status || r.status.status === opts.status));
}
