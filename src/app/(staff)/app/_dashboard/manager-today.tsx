"use client";
// v4 RN-5 Manager: today's operations — utilization, bookings, bar, shop, staff on shift, cancellations. Every number
// opens its filtered list (a screen on the Manager's menu).
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Money } from "@/components/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { UtilizationHeatmap } from "./charts";
import { StatCard } from "./kpi-card";

type F = { value: number; href: string; hint?: string };
type Today = {
  date: string;
  generatedAt: string;
  utilization: { pct: number; bookedHours: number; openHours: number; href: string; heatmap: { hours: number[]; courts: Array<{ court: string; cells: number[] }> } };
  bookings: F; noShows: F; cancellations: F; clubCancellationsPending: F;
  bar: { collected: F; openTabs: F; settledTabs: F };
  shop: { sales: F; total: F };
  staff: { clockedIn: F; notIn: F; onLeave: F };
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ManagerToday() {
  const state = useApi<Today>("/api/dashboards/manager", { pollMs: 60_000 });
  return (
    <DataState state={state}>
      {(t) => (
        <div className="flex flex-col gap-4" data-testid="manager-today">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Today&apos;s operations · {fmtDate(t.date)}</h2>
          <Section title="Courts">
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <StatCard label="Court utilization" value={`${t.utilization.pct}%`} hint={`${t.utilization.bookedHours} of ${t.utilization.openHours} open court-hours`} href={t.utilization.href} />
                <StatCard label="Bookings" value={t.bookings.value} href={t.bookings.href} />
                <StatCard label="Cancellations" value={t.cancellations.value} href={t.cancellations.href} />
                <StatCard label="No-shows" value={t.noShows.value} href={t.noShows.href} />
                <StatCard label="Club cancellations pending choice" value={t.clubCancellationsPending.value} href={t.clubCancellationsPending.href} />
              </div>
              <UtilizationHeatmap hours={t.utilization.heatmap.hours} courts={t.utilization.heatmap.courts} />
            </div>
          </Section>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Section title="Bar & cafeteria">
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Collected today" value={<Money paise={t.bar.collected.value} />} href={t.bar.collected.href} />
                <StatCard label="Open tabs" value={t.bar.openTabs.value} href={t.bar.openTabs.href} hint={`${t.bar.settledTabs.value} settled today`} />
              </div>
            </Section>
            <Section title="Shop">
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Counter sales today" value={t.shop.sales.value} href={t.shop.sales.href} />
                <StatCard label="Sales total" value={<Money paise={t.shop.total.value} />} href={t.shop.total.href} />
              </div>
            </Section>
            <Section title="Staff on shift">
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Clocked in" value={t.staff.clockedIn.value} href={t.staff.clockedIn.href} />
                <StatCard label="Not in yet" value={<span className={t.staff.notIn.value ? "text-warning-text" : ""}>{t.staff.notIn.value}</span>} href={t.staff.notIn.href} hint={t.staff.notIn.hint} />
                <StatCard label="On leave" value={t.staff.onLeave.value} href={t.staff.onLeave.href} />
              </div>
            </Section>
          </div>
          <p className="text-right text-[11px] text-muted-foreground">Generated {fmtDateTime(t.generatedAt)} · refreshes every minute</p>
        </div>
      )}
    </DataState>
  );
}
