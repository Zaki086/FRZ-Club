// v4 RN-5 — the role dashboards (Owner, Manager, Front desk). Read-only. Every number is read from the database
// through the same lists and services the linked screens use, and comes with the link to its filtered list
// (v3 §3.3) — always a page that role may open (RN-1).
import { clock } from "@/lib/clock";
import { istDate, istDayRange } from "@/lib/time";
import { prisma } from "../db";
import type { Actor } from "../rbac/actor";
import { assertCan, assertUser, can } from "../rbac/permissions";
import { checkinRisks, RISK_SOON_HOURS } from "./checkin-risk";
import { cashSummary, myDrawerBalance } from "./drawers";
import { listView } from "./filters";
import { listExpiring } from "./members";
import { refundsPayableSummary } from "./refunds";
import { utilization } from "./reports";
import { messagesToSend, myOverdueFollowUps } from "./todo";

/** A dashboard number and the list it opens. */
export type Figure = { value: number; href: string; hint?: string };

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** The bookings list's own counts for today (status facet) — the numbers the linked list shows. */
async function bookingsToday(actor: Actor) {
  const l = await listView(actor, "bookings", { range: "TODAY" });
  const by = (v: string) => l.facets.find((f) => f.key === "status")?.options.find((o) => o.value === v)?.count ?? 0;
  return { booked: by("CONFIRMED") + by("COMPLETED") + by("NO_SHOW"), noShows: by("NO_SHOW"), cancelled: by("CANCELLED") + by("CANCELLED_BY_CLUB") };
}

const BAR_DAY = "/app/bar/day";

/**
 * RN-5 Manager: today's operations — utilization, bookings, bar, shop, staff on shift and cancellations. Each figure
 * opens its filtered list on the Manager's own menu.
 */
export async function managerToday(actor: Actor) {
  assertCan(actor, "dashboard.ops");
  const now = clock.now();
  const today = istDate(now);
  const [from, to] = istDayRange(today);
  const [util, bk, pendingChoice, sales, staff, barIn, openTabs, settledTabs] = await Promise.all([
    utilization(today, today),
    bookingsToday(actor),
    prisma.clubCancellation.count({ where: { status: "PENDING_CHOICE" } }),
    listView(actor, "sales", { range: "TODAY" }),
    listView(actor, "employees", { status: "ACTIVE,ON_LEAVE" }),
    prisma.ledgerEntry.aggregate({ where: { source: "BAR", direction: "IN", occurredAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    prisma.tab.count({ where: { status: "OPEN" } }),
    prisma.tab.count({ where: { status: "SETTLED", settledAt: { gte: from, lt: to } } }),
  ]);
  const presence = (v: string) => staff.facets.find((f) => f.key === "presence")?.options.find((o) => o.value === v)?.count ?? 0;
  const sum = (k: string) => sales.summary.find((s) => s.key === k)?.value ?? 0;
  const bookings = (status: string) => `/app/courts/bookings?${q({ range: "TODAY", status })}`;
  return {
    date: today,
    generatedAt: now.toISOString(),
    utilization: { pct: util.pct, bookedHours: util.bookedHours, openHours: util.openHours, href: "/app/courts", heatmap: util.heatmap },
    bookings: { value: bk.booked, href: bookings("CONFIRMED,COMPLETED,NO_SHOW") } satisfies Figure,
    noShows: { value: bk.noShows, href: bookings("NO_SHOW") } satisfies Figure,
    cancellations: { value: bk.cancelled, href: bookings("CANCELLED,CANCELLED_BY_CLUB") } satisfies Figure,
    clubCancellationsPending: { value: pendingChoice, href: `/app/courts/bookings?${q({ resolution: "PENDING_CHOICE" })}` } satisfies Figure,
    bar: {
      collected: { value: barIn._sum.amount ?? 0, href: BAR_DAY } satisfies Figure,
      openTabs: { value: openTabs, href: BAR_DAY } satisfies Figure,
      settledTabs: { value: settledTabs, href: BAR_DAY } satisfies Figure,
    },
    shop: {
      sales: { value: sum("count"), href: `/app/shop/sales?${q({ range: "TODAY" })}` } satisfies Figure,
      total: { value: sum("total"), href: `/app/shop/sales?${q({ range: "TODAY" })}` } satisfies Figure,
    },
    staff: {
      clockedIn: { value: presence("IN"), href: `/app/staff/employees?${q({ status: "ACTIVE,ON_LEAVE", presence: "IN" })}` } satisfies Figure,
      notIn: { value: presence("DUE"), href: `/app/staff/employees?${q({ status: "ACTIVE,ON_LEAVE", presence: "DUE" })}`, hint: "On shift now, not clocked in" } satisfies Figure,
      onLeave: { value: staff.facets.find((f) => f.key === "status")?.options.find((o) => o.value === "ON_LEAVE")?.count ?? 0, href: `/app/staff/employees?${q({ status: "ON_LEAVE" })}` } satisfies Figure,
    },
  };
}

/** RN-5 Owner: the cash summary card — cash collected today, in drawers now, in the safe, and refunds payable. */
export async function ownerCash(actor: Actor) {
  assertCan(actor, "dashboard.full");
  const [cash, payable] = await Promise.all([cashSummary(), refundsPayableSummary()]);
  return {
    // The day's cash reconciliation lists the cash payments behind this figure (ledger vs drawer).
    collectedToday: { value: cash.collectedTodayPaise, href: "/app/finance/cash" } satisfies Figure,
    inDrawers: { value: cash.inDrawersNowPaise, href: "/app/finance/drawers" } satisfies Figure,
    inSafe: { value: cash.inSafePaise, href: "/app/finance/cash" } satisfies Figure,
    refundsPayable: {
      value: payable.amountPaise,
      count: payable.count,
      oldestDays: payable.oldestDays,
      href: `/app/refunds?${q({ status: "APPROVED" })}`,
    },
  };
}

/**
 * RN-5 Front desk: my drawer, arrivals in the next 2 hours, check-in risks, refunds ready to pay out, renewals due
 * this week, messages to send and my overdue leads.
 */
export async function frontDeskToday(actor: Actor) {
  assertCan(actor, "dashboard.desk");
  assertUser(actor);
  const now = clock.now();
  const soon = new Date(now.getTime() + RISK_SOON_HOURS * 3_600_000);
  const [drawer, risks, payable, expiring, toSend, overdue, bookings, social] = await Promise.all([
    myDrawerBalance(actor),
    checkinRisks(actor),
    refundsPayableSummary(),
    listExpiring(actor),
    can(actor, "notifications.log") ? messagesToSend() : Promise.resolve(null),
    can(actor, "crm") ? myOverdueFollowUps(actor) : Promise.resolve(null),
    prisma.booking.findMany({
      where: { status: "CONFIRMED", reservation: { endAt: { gt: now }, startAt: { lt: soon } } },
      include: { reservation: { include: { court: { select: { name: true } } } }, players: { where: { removedAt: null } } },
      orderBy: { reservation: { startAt: "asc" } },
    }),
    prisma.socialSession.findMany({
      where: { status: "SCHEDULED", endAt: { gt: now }, startAt: { lt: soon } },
      include: { participants: { where: { status: "JOINED" } } },
      orderBy: { startAt: "asc" },
    }),
  ]);
  const memberIds = bookings.flatMap((b) => b.players.map((p) => p.memberId)).filter((x): x is string => !!x);
  const guestIds = bookings.flatMap((b) => b.players.map((p) => p.guestId)).filter((x): x is string => !!x);
  const [members, guests] = await Promise.all([
    prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } }),
    prisma.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true } }),
  ]);
  const who = (m: string | null, g: string | null) => (m && members.find((x) => x.id === m)?.name) || (g && guests.find((x) => x.id === g)?.name) || "Player";
  const arrivals = [
    ...bookings.map((b) => ({
      key: `booking:${b.id}`, title: `${b.reservation.court.name} · ${b.bookingCode}`, startAt: b.reservation.startAt.toISOString(), endAt: b.reservation.endAt.toISOString(),
      people: b.players.map((p) => who(p.memberId, p.guestId)), checkedIn: b.players.filter((p) => p.checkedInAt).length, total: b.players.length,
      href: `/app/courts/bookings?${q({ q: b.bookingCode })}`,
    })),
    ...social.map((s) => ({
      key: `social:${s.id}`, title: `Social play · ${s.title}`, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(),
      people: [], checkedIn: s.participants.filter((p) => p.checkedInAt).length, total: s.participants.length,
      href: "/app/courts/social",
    })),
  ].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const today = istDate(now);
  const renewals = expiring.filter((e) => e.endDate >= today);
  return {
    generatedAt: now.toISOString(),
    drawer: drawer.open ? { name: drawer.open.name, balancePaise: drawer.open.balancePaise, href: "/app/drawer" } : { name: null, balancePaise: null, href: "/app/drawer" },
    arrivals: { value: arrivals.reduce((n, a) => n + Math.max(0, a.total - a.checkedIn), 0), sessions: arrivals.length, items: arrivals, href: `/app/courts/bookings?${q({ range: "TODAY", status: "CONFIRMED" })}` },
    risks: { value: risks.total, soon: risks.soon, href: "/app/desk/risk" },
    refundsReady: { value: payable.count, amountPaise: payable.amountPaise, oldestDays: payable.oldestDays, href: `/app/refunds?${q({ status: "APPROVED" })}` },
    renewals: { value: renewals.length, href: "/app/desk/expiring" } satisfies Figure,
    messagesToSend: toSend === null ? null : ({ value: toSend, href: `/app/messages?${q({ channel: "WHATSAPP_MANUAL", status: "QUEUED,LINK_OPENED" })}` } satisfies Figure),
    overdueLeads: overdue === null ? null : ({ value: overdue, href: `/app/crm?${q({ status: "NEW,CONTACTED,QUOTED", assignee: "me", overdue: "yes" })}` } satisfies Figure),
  };
}
