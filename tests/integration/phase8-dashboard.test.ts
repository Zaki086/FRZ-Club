import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { cancelBooking } from "@/server/services/booking";
import { counterSale } from "@/server/services/shop";
import { addLines, openTab, settleTab } from "@/server/services/bar";
import { createExpense, payExpense } from "@/server/services/expenses";
import { createShareLink, dashboard, drillDown, exportCsv, getSharedReport, INCOME_SOURCES, METHODS, resolvePeriod, revokeShareLink } from "@/server/services/reports";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";
import { makeProduct } from "../helpers/shop";
import { makeBar } from "../helpers/bar";
import { expectIntegrity } from "../helpers/integrity";

let w: World;

async function activity(day: string) {
  clock.set(istToUtc(day, "09:00"));
  const m = await makeMember(w, { name: `Member ${day}`, plan: "SILVER" });
  await book(w, { date: day, time: "18:00", players: [{ memberId: m.memberId }, guest(`Friend ${day}`)], payment: { kind: "COUNTER", method: "UPI", reference: "U" } });
  const cancelled = await book(w, { court: "Court 2", date: day, time: "19:00", players: [guest(`Canceller ${day}`)], payment: { kind: "COUNTER", method: "CARD" } });
  await cancelBooking(w.actors.FRONT_DESK, cancelled.bookingId);
  const p = await makeProduct(w, { name: `Balls ${day}`, category: "BALLS", price: 50000, onHand: 5 });
  await counterSale(w.actors.SHOP_STAFF, { memberId: m.memberId, items: [{ variantId: p.variantId, qty: 2 }], payments: [{ method: "CASH" }] });
  const bar = await makeBarOnce();
  const t = await openTab(w.actors.BAR_STAFF, { memberId: m.memberId });
  await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.sandwich.id, qty: 1 }] });
  await settleTab(w.actors.BAR_STAFF, t.tabId, { payments: [{ method: "CASH", amount: 28800 }] });
  const e = await createExpense(w.actors.ACCOUNTANT, { vendor: "Water Co", category: "UTILITIES", amount: 120000 });
  await payExpense(w.actors.ACCOUNTANT, e.id, { method: "UPI" });
}

let barFixture: Awaited<ReturnType<typeof makeBar>> | null = null;
async function makeBarOnce() {
  barFixture ??= await makeBar(w);
  return barFixture;
}

beforeEach(async () => {
  w = await makeWorld(istToUtc("2026-10-01", "09:00"));
  barFixture = null;
  for (const day of ["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"]) await activity(day);
  clock.set(istToUtc("2026-10-14", "21:00"));
});

describe("Phase 8 — owner dashboard reconciles (DB-1…DB-3, §9.7)", () => {
  for (const period of ["TODAY", "WEEK", "MONTH"] as const) {
    it(`DB-3: ${period}: collected = Σ sources = Σ methods = Σ drill-down rows, for every source and method`, async () => {
      const d = (await dashboard(w.actors.OWNER, { period })) as unknown as {
        money: { collected: { value: number }; bySource: Record<string, { value: number }>; byMethod: Record<string, { value: number }>; expenses: { value: number } };
      };
      const sumSources = INCOME_SOURCES.reduce((a, s) => a + d.money.bySource[s].value, 0);
      const sumMethods = METHODS.reduce((a, m) => a + d.money.byMethod[m].value, 0);
      expect(sumSources).toBe(d.money.collected.value);
      expect(sumMethods).toBe(d.money.collected.value);
      expect(d.money.collected.value).toBeGreaterThan(0);
      const dd = await drillDown(w.actors.OWNER, "collected", { period });
      expect(dd.rows.reduce((a, r) => a + r.amount, 0)).toBe(d.money.collected.value);
      for (const s of INCOME_SOURCES) {
        const x = await drillDown(w.actors.OWNER, `source:${s}`, { period });
        expect(x.rows.reduce((a, r) => a + r.amount, 0), s).toBe(d.money.bySource[s].value);
      }
      for (const m of METHODS) {
        const x = await drillDown(w.actors.OWNER, `method:${m}`, { period });
        expect(x.rows.reduce((a, r) => a + r.amount, 0), m).toBe(d.money.byMethod[m].value);
      }
      const ex = await drillDown(w.actors.OWNER, "expenses", { period });
      expect(ex.total).toBe(d.money.expenses.value);
    });
  }

  it("DB-1: periods and the previous equivalent period", () => {
    expect(resolvePeriod({ period: "WEEK" }, "2026-10-14")).toMatchObject({ from: "2026-10-12", to: "2026-10-14", prevFrom: "2026-10-05", prevTo: "2026-10-07" });
    expect(resolvePeriod({ period: "MONTH" }, "2026-10-31")).toMatchObject({ from: "2026-10-01", prevFrom: "2026-09-01", prevTo: "2026-09-30" });
    expect(resolvePeriod({ period: "TODAY" }, "2026-10-14")).toMatchObject({ prevFrom: "2026-10-13" });
  });

  it("DB-1: week-over-week change is computed, never typed: this week (12–14) vs last week (5–7) had the same activity", async () => {
    const d = (await dashboard(w.actors.OWNER, { period: "WEEK" })) as unknown as { money: { collected: { value: number; prev: number; change: number | null } } };
    expect(d.money.collected.prev).toBe(d.money.collected.value);
    expect(d.money.collected.change).toBe(0);
  });

  it("DB-2: the court booking KPIs count bookings, cancellations; utilization is booked ÷ open hours", async () => {
    const d = (await dashboard(w.actors.OWNER, { period: "TODAY" })) as unknown as { ops: { bookings: { value: number }; cancellations: { value: number }; utilization: { pct: number; bookedHours: number; openHours: number } } };
    expect(d.ops.bookings.value).toBe(2);
    expect(d.ops.cancellations.value).toBe(1);
    expect(d.ops.utilization.bookedHours).toBe(1);
    expect(d.ops.utilization.openHours).toBe(6 * 16);
  });

  it("DB-6: role-scoped dashboards — the manager sees no payroll or net cash flow; bar staff see the bar; members none", async () => {
    const mgr = (await dashboard(w.actors.MANAGER, { period: "MONTH" })) as unknown as { scope: string; money: Record<string, unknown> };
    expect(mgr.scope).toBe("OPS");
    expect(mgr.money.payroll).toBeUndefined();
    expect(mgr.money.netCashFlow).toBeUndefined();
    const bar = (await dashboard(w.actors.BAR_STAFF, { period: "MONTH" })) as unknown as { scope: string; money: Record<string, unknown> };
    expect(bar.scope).toBe("BAR");
    expect(Object.keys(bar.money)).toEqual(["collected"]);
    await expect(drillDown(w.actors.BAR_STAFF, "collected", { period: "MONTH" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(drillDown(w.actors.MANAGER, "payroll", { period: "MONTH" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const m = await makeMember(w, { name: "Nosy Member", plan: "GOLD" });
    await expect(dashboard(m.actor, { period: "TODAY" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectIntegrity();
  });

  it("DB-5: CSV export and read-only share links (expiring, revocable, owner only)", async () => {
    const csv = await exportCsv(w.actors.OWNER, "drilldown", { period: "MONTH", metric: "source:COURTS" });
    expect(csv.split("\n")[0]).toBe("When (IST),Source,Method,Description,Amount (₹)");
    await expect(createShareLink(w.actors.MANAGER, { period: "MONTH" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const link = await createShareLink(w.actors.OWNER, { period: "MONTH" });
    const token = link.url.split("/").pop()!;
    const shared = await getSharedReport(token);
    expect(shared.summary).toMatch(/collected/);
    await revokeShareLink(w.actors.OWNER, link.id);
    await expect(getSharedReport(token)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/revoked/) });
    const l2 = await createShareLink(w.actors.OWNER, { period: "TODAY", days: 1 });
    clock.advance(2 * 86_400_000);
    await expect(getSharedReport(l2.url.split("/").pop()!)).rejects.toMatchObject({ message: expect.stringMatching(/expired/) });
  });
});
