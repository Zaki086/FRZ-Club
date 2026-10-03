// Completion pass §7 (front desk): the "Today" home — who is arriving next, what is still to collect, what is
// waiting (refunds, expiring memberships) and the state of my cash drawer. Read-only; every number comes from the
// same services the other screens use.
import { clock } from "@/lib/clock";
import { addDays, istDate, istDayRange } from "@/lib/time";
import { prisma } from "../db";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { listBookings } from "./booking";
import { myDrawer } from "./drawers";

export async function deskToday(actor: Actor) {
  assertCan(actor, "checkin");
  const now = clock.now();
  const today = istDate(now);
  const bookings = await listBookings(actor, { date: today, status: "CONFIRMED" });
  const soon = now.getTime() + 3 * 3_600_000;
  const arriving = bookings
    .filter((b) => b.endAt.getTime() > now.getTime() && b.startAt.getTime() <= soon)
    .map((b) => ({ id: b.id, code: b.code, court: b.court, startAt: b.startAt, due: b.due, players: b.players.map((p) => p.name), checkedIn: b.players.filter((p) => p.checkedInAt).length, total: b.players.length }));
  const dues = bookings.filter((b) => b.due > 0);
  const [from] = istDayRange(today);
  const [, weekEnd] = istDayRange(addDays(today, 7));
  const [checkins, pendingRefunds, expiring] = await Promise.all([
    prisma.visit.count({ where: { checkedInAt: { gte: from } } }),
    prisma.payment.count({ where: { type: "REFUND", status: "PENDING" } }),
    prisma.membership.count({ where: { status: "ACTIVE", endDate: { gte: new Date(`${today}T00:00:00Z`), lt: weekEnd } } }),
  ]);
  const drawer = await myDrawer(actor);
  return {
    date: today,
    arriving,
    dues: { count: dues.length, total: dues.reduce((a, b) => a + b.due, 0), items: dues.slice(0, 10).map((b) => ({ id: b.id, code: b.code, court: b.court, startAt: b.startAt, due: b.due })) },
    bookingsToday: bookings.length,
    checkinsToday: checkins,
    pendingRefunds,
    expiringThisWeek: expiring,
    drawer: drawer.open ? { area: drawer.open.area, cashExpected: drawer.open.cashExpected, openedAt: drawer.open.openedAt } : null,
  };
}
