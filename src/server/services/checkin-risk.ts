// v4 §1.2 "Check-in Risk" (front desk): today's arrivals — and the next 2 hours' — that will hit a problem at the
// desk, each problem with its one-click fix on the screen that already does it. Read-only; every number comes from
// the same records those screens use (bills, memberships, tabs, club cancellations).
//  RN-6 rules (one row per arrival not yet checked in; a problem per player where it is the player's):
//   UNPAID                  the booking's / social place's bill still has money due (CI-2 blocks check-in) → Collect ₹X
//   MEMBERSHIP_EXPIRED      a member whose last membership has ended and nothing new has started → Renew
//   MEMBERSHIP_EXPIRING     a member whose current membership ends within 7 days and no renewal is lined up → Renew
//   DUES                    a member with other unpaid bills (dues) → Collect ₹X on the member page
//   OPEN_TAB                a member with an open or carried bar tab → Settle (bar) / see it on the member page
//   CLUB_CANCELLED_PENDING  a member with a club-cancelled paid session still waiting for their choice → Reschedule or refund
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, fmtDate, fromDbDate, istDate, istDayRange } from "@/lib/time";
import { prisma } from "../db";
import type { Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { billDue } from "./bills";

export const RISK_KINDS = ["UNPAID", "MEMBERSHIP_EXPIRED", "MEMBERSHIP_EXPIRING", "DUES", "OPEN_TAB", "CLUB_CANCELLED_PENDING"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];
export const RISK_LABEL: Record<RiskKind, string> = {
  UNPAID: "Unpaid", MEMBERSHIP_EXPIRED: "Membership expired", MEMBERSHIP_EXPIRING: "Membership expiring", DUES: "Dues",
  OPEN_TAB: "Open bar tab", CLUB_CANCELLED_PENDING: "Club cancellation pending",
};
/** How far ahead "soon" looks (and how far past midnight the list reaches). */
export const RISK_SOON_HOURS = 2;
export const EXPIRING_DAYS = 7;

export type CheckinRisk = {
  kind: RiskKind; who: string; problem: string; amountPaise: number | null; fix: { label: string; href: string };
  /** v5 §3.3: the member this problem is about (the composer's "Send message" target); null for a booking's unpaid bill or a guest. */
  memberId: string | null;
};
export type RiskArrival = {
  key: string;
  type: "BOOKING" | "SOCIAL";
  code: string | null;
  title: string;
  startAt: string;
  endAt: string;
  /** Starts within the next 2 hours (or is on now). */
  soon: boolean;
  players: string[];
  risks: CheckinRisk[];
};

type Person = { memberId: string | null; name: string };
type Arrival = Omit<RiskArrival, "risks" | "players"> & { billId: string | null; people: Person[] };

const bookingHref = (code: string) => `/app/courts/bookings?q=${encodeURIComponent(code)}`;
const memberHref = (id: string) => `/app/members/${id}`;

/** Per member: what would stop or trouble their check-in, independent of which arrival it is. */
async function memberProblems(actor: Actor, memberIds: string[], today: string) {
  const out = new Map<string, Array<Omit<CheckinRisk, "who" | "memberId">>>();
  const [memberships, bills, tabs, pending] = await Promise.all([
    prisma.membership.findMany({ where: { memberId: { in: memberIds } }, select: { memberId: true, status: true, startDate: true, endDate: true } }),
    prisma.bill.findMany({ where: { memberId: { in: memberIds }, closedAt: null }, select: { id: true, memberId: true, total: true, amountPaid: true, amountRefunded: true, closedAt: true } }),
    prisma.tab.findMany({ where: { memberId: { in: memberIds }, status: { in: ["OPEN", "CARRIED"] } }, select: { id: true, code: true, memberId: true, status: true, barDate: true, billId: true } }),
    prisma.$queryRaw<{ member_id: string; code: string; deadline_at: Date }[]>`
      SELECT DISTINCT ON (x.member_id, b.id) x.member_id, b.booking_code AS code, cc.deadline_at
        FROM club_cancellations cc
        JOIN bookings b ON b.id = cc.booking_id
        JOIN LATERAL (SELECT b.primary_member_id AS member_id UNION SELECT bp.member_id FROM booking_players bp WHERE bp.booking_id = b.id) x ON TRUE
       WHERE cc.status = 'PENDING_CHOICE' AND x.member_id = ANY(${memberIds}::text[])`,
  ]);
  const tabBills = await prisma.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } }, select: { id: true, total: true, amountPaid: true, amountRefunded: true, closedAt: true } });
  const add = (id: string, r: Omit<CheckinRisk, "who" | "memberId">) => out.set(id, [...(out.get(id) ?? []), r]);
  for (const id of memberIds) {
    const mine = memberships.filter((m) => m.memberId === id);
    const day = (d: Date) => fromDbDate(d);
    const current = mine.filter((m) => m.status === "ACTIVE" && day(m.startDate) <= today && day(m.endDate) >= today).sort((a, b) => day(b.endDate).localeCompare(day(a.endDate)))[0];
    const lined = mine.some((m) => (m.status === "SCHEDULED" || m.status === "PENDING_PAYMENT") && (!current || day(m.startDate) > today));
    const past = mine.some((m) => ["ACTIVE", "EXPIRED", "CHANGED", "CANCELLED"].includes(m.status));
    if (current && day(current.endDate) <= addDays(today, EXPIRING_DAYS) && !lined) {
      add(id, { kind: "MEMBERSHIP_EXPIRING", problem: `Membership ends ${fmtDate(day(current.endDate))}`, amountPaise: null, fix: { label: "Renew", href: memberHref(id) } });
    } else if (!current && !lined && past) {
      const last = mine.filter((m) => m.status !== "PENDING_PAYMENT").sort((a, b) => day(b.endDate).localeCompare(day(a.endDate)))[0];
      add(id, { kind: "MEMBERSHIP_EXPIRED", problem: last ? `Membership ended ${fmtDate(day(last.endDate))} — priced as a walk-in` : "No current membership", amountPaise: null, fix: { label: "Renew", href: memberHref(id) } });
    }
    for (const t of tabs.filter((x) => x.memberId === id)) {
      const b = tabBills.find((x) => x.id === t.billId);
      const due = b ? billDue(b) : 0;
      add(id, {
        kind: "OPEN_TAB",
        problem: `Bar tab ${t.code} ${t.status === "CARRIED" ? "carried over" : "open"} since ${fmtDate(fromDbDate(t.barDate))}${due ? ` · ${formatINR(due)} to settle` : ""}`,
        amountPaise: due || null,
        fix: can(actor, "bar.operate") ? { label: "Settle tab", href: `/app/bar/tabs/${t.id}` } : { label: "Settle at the bar", href: memberHref(id) },
      });
    }
    for (const p of pending.filter((x) => x.member_id === id)) {
      add(id, {
        kind: "CLUB_CANCELLED_PENDING",
        problem: `${p.code} was cancelled by the club — choice due by ${fmtDate(istDate(p.deadline_at))}`,
        amountPaise: null,
        fix: { label: "Reschedule or refund", href: `${bookingHref(p.code)}&resolution=PENDING_CHOICE` },
      });
    }
  }
  const dueBills = bills.map((b) => ({ id: b.id, memberId: b.memberId, due: billDue(b) })).filter((b) => b.due > 0);
  /** The member's problems plus dues on bills other than the arrival's own (that one is UNPAID) and their tabs. */
  return (id: string, exceptBillIds: string[]) => {
    const dues = dueBills.filter((b) => b.memberId === id && !exceptBillIds.includes(b.id) && !tabBills.some((t) => t.id === b.id));
    const total = dues.reduce((a, b) => a + b.due, 0);
    const list = [...(out.get(id) ?? [])];
    if (total > 0) list.unshift({ kind: "DUES", problem: `${dues.length} unpaid bill${dues.length === 1 ? "" : "s"} · ${formatINR(total)} due`, amountPaise: total, fix: { label: `Collect ${formatINR(total)}`, href: memberHref(id) } });
    return list;
  };
}

/**
 * The Check-in Risk list: arrivals (bookings and social places not yet checked in) from now until the end of today
 * or the next 2 hours, whichever is later — only those with at least one problem, earliest first.
 */
export async function checkinRisks(actor: Actor) {
  assertCan(actor, "checkin");
  const now = clock.now();
  const today = istDate(now);
  const soonEnd = new Date(now.getTime() + RISK_SOON_HOURS * 3_600_000);
  const dayEnd = istDayRange(today)[1];
  const until = soonEnd > dayEnd ? soonEnd : dayEnd;

  const [bookings, social] = await Promise.all([
    prisma.booking.findMany({
      where: { status: "CONFIRMED", reservation: { endAt: { gt: now }, startAt: { lt: until } } },
      include: { reservation: { include: { court: { select: { name: true } } } }, players: { where: { removedAt: null } } },
    }),
    prisma.socialParticipant.findMany({
      where: { status: "JOINED", checkedInAt: null, session: { status: "SCHEDULED", endAt: { gt: now }, startAt: { lt: until } } },
      include: { session: true },
    }),
  ]);
  const memberIds = [...new Set([...bookings.flatMap((b) => b.players.map((p) => p.memberId)), ...social.map((s) => s.memberId)].filter((x): x is string => !!x))];
  const guestIds = [...new Set([...bookings.flatMap((b) => b.players.map((p) => p.guestId)), ...social.map((s) => s.guestId)].filter((x): x is string => !!x))];
  const [members, guests] = await Promise.all([
    prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } }),
    prisma.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true } }),
  ]);
  const name = (memberId: string | null, guestId: string | null) =>
    (memberId && members.find((m) => m.id === memberId)?.name) || (guestId && guests.find((g) => g.id === guestId)?.name) || "Player";

  const arrivals: Arrival[] = [
    ...bookings
      .filter((b) => b.players.some((p) => !p.checkedInAt))
      .map((b) => ({
        key: `booking:${b.id}`, type: "BOOKING" as const, code: b.bookingCode, title: `${b.reservation.court.name} · ${b.bookingCode}`,
        startAt: b.reservation.startAt.toISOString(), endAt: b.reservation.endAt.toISOString(), soon: b.reservation.startAt <= soonEnd,
        billId: b.billId, people: b.players.filter((p) => !p.checkedInAt).map((p) => ({ memberId: p.memberId, name: name(p.memberId, p.guestId) })),
      })),
    ...social.map((s) => ({
      key: `social:${s.id}`, type: "SOCIAL" as const, code: null, title: `Social play · ${s.session.title}`,
      startAt: s.session.startAt.toISOString(), endAt: s.session.endAt.toISOString(), soon: s.session.startAt <= soonEnd,
      billId: s.billId, people: [{ memberId: s.memberId, name: name(s.memberId, s.guestId) }],
    })),
  ];
  const billIds = arrivals.map((a) => a.billId).filter((x): x is string => !!x);
  const [ownBills, problemsOf] = await Promise.all([
    prisma.bill.findMany({ where: { id: { in: billIds } }, select: { id: true, total: true, amountPaid: true, amountRefunded: true, closedAt: true } }),
    memberProblems(actor, memberIds, today),
  ]);

  const rows: RiskArrival[] = [];
  for (const a of arrivals) {
    const risks: CheckinRisk[] = [];
    const bill = a.billId ? ownBills.find((b) => b.id === a.billId) : null;
    const due = bill ? billDue(bill) : 0;
    if (due > 0) {
      const href = a.type === "BOOKING" ? bookingHref(a.code!) : `/app/courts/social/players?q=${encodeURIComponent(a.people[0].name)}&when=upcoming`;
      risks.push({ kind: "UNPAID", who: a.people.map((p) => p.name).join(", "), problem: `${formatINR(due)} unpaid — check-in needs it paid first`, amountPaise: due, fix: { label: `Collect ${formatINR(due)}`, href }, memberId: a.type === "SOCIAL" ? a.people[0].memberId : null });
    }
    const seen = new Set<string>();
    for (const p of a.people) {
      if (!p.memberId || seen.has(p.memberId)) continue;
      seen.add(p.memberId);
      for (const r of problemsOf(p.memberId, a.billId ? [a.billId] : [])) risks.push({ ...r, who: p.name, memberId: p.memberId });
    }
    if (risks.length) rows.push({ key: a.key, type: a.type, code: a.code, title: a.title, startAt: a.startAt, endAt: a.endAt, soon: a.soon, players: a.people.map((p) => p.name), risks });
  }
  rows.sort((x, y) => x.startAt.localeCompare(y.startAt) || x.title.localeCompare(y.title));
  const counts = Object.fromEntries(RISK_KINDS.map((k) => [k, rows.reduce((n, r) => n + r.risks.filter((x) => x.kind === k).length, 0)])) as Record<RiskKind, number>;
  return { generatedAt: now.toISOString(), until: until.toISOString(), soonUntil: soonEnd.toISOString(), arrivals: rows, counts, total: rows.length, soon: rows.filter((r) => r.soon).length };
}

/** For the dashboards: how many arrivals have a problem (all of today's and the next 2 hours'). */
export async function checkinRiskCount(actor: Actor): Promise<{ total: number; soon: number }> {
  const r = await checkinRisks(actor);
  return { total: r.total, soon: r.soon };
}
