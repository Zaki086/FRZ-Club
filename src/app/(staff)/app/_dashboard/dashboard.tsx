"use client";
import Link from "next/link";
import { useState } from "react";
import { Download } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { DailyRevenueChart, UtilizationHeatmap } from "./charts";
import { DrillDownDialog } from "./drilldown-dialog";
import { KpiCard, StatCard } from "./kpi-card";
import { PeriodPicker } from "./period-picker";
import { METHODS, METHOD_LABEL, SOURCES, SOURCE_LABEL, periodQuery, periodReady, type Dashboard, type PeriodState } from "./types";

const SCOPE_LABEL: Record<string, string> = {
  FULL: "Owner view", OPS: "Operations view", FINANCE: "Finance view", BAR: "Bar view", SHOP: "Shop view", DESK: "Today's desk view",
};

export function DashboardView({ todo, today }: { todo: React.ReactNode; today: string }) {
  const [period, setPeriod] = useState<PeriodState>({ period: "TODAY", from: today, to: today });
  const [drill, setDrill] = useState<{ metric: string; title: string } | null>(null);
  const query = periodQuery(period);
  const state = useApi<Dashboard>(periodReady(period) ? `/api/reports/dashboard?${query}` : null, { pollMs: 60_000 });
  const open = (metric: string, title: string) => setDrill({ metric, title });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {state.data ? `${SCOPE_LABEL[state.data.scope]} · ${state.data.period.label} (${fmtDate(state.data.period.from)} – ${fmtDate(state.data.period.to)}) vs ${fmtDate(state.data.period.prevFrom)} – ${fmtDate(state.data.period.prevTo)}` : "Every number is read from the ledger and clicks through to its records."}
          </p>
        </div>
        {state.data?.scope !== "DESK" ? <PeriodPicker value={period} onChange={setPeriod} /> : null}
      </div>
      {todo}
      {!periodReady(period) ? <p className="text-sm text-muted-foreground">Choose a valid from and to date.</p> : null}
      <DataState state={state}>
        {(d) => <DashboardBody d={d} open={open} query={query} />}
      </DataState>
      <DrillDownDialog metric={drill?.metric ?? null} title={drill?.title ?? ""} query={query} onClose={() => setDrill(null)} />
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DashboardBody({ d, open, query }: { d: Dashboard; open: (metric: string, title: string) => void; query: string }) {
  const m = d.money;
  const scope = d.scope;
  const moneyGrid = "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6";
  return (
    <div className="flex flex-col gap-4">
      {/* Money: collected and its breakdown (R-38) */}
      {m.collected && m.bySource ? (
        <Section
          title="Money collected (net of refunds)"
          action={
            <Button asChild variant="outline" size="sm">
              <a href={`/api/reports/csv?report=dashboard&${query}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiCard label="Collected" kpi={m.collected} onClick={() => open("collected", "Collected — all ledger income")} testId="kpi-collected" />
              {m.expenses ? <KpiCard label="Expenses paid" kpi={m.expenses} invert onClick={() => open("expenses", "Expenses paid")} /> : null}
              {m.payroll ? <KpiCard label="Payroll paid" kpi={m.payroll} invert onClick={() => open("payroll", "Payroll paid")} /> : null}
              {m.netCashFlow ? <KpiCard label="Net cash flow" kpi={m.netCashFlow} hint="Collected − expenses − payroll" /> : null}
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By source</p>
            <div className={moneyGrid}>
              {SOURCES.map((s) => (
                <KpiCard key={s} label={SOURCE_LABEL[s]} kpi={m.bySource![s]} onClick={() => open(`source:${s}`, `${SOURCE_LABEL[s]} — collected`)} testId={`kpi-source-${s}`} />
              ))}
            </div>
            {m.byMethod ? (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By method</p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {METHODS.map((k) => (
                    <KpiCard key={k} label={METHOD_LABEL[k]} kpi={m.byMethod![k]} onClick={() => open(`method:${k}`, `${METHOD_LABEL[k]} — collected`)} testId={`kpi-method-${k}`} />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* Reduced money views for bar / shop / desk scopes */}
      {scope === "BAR" && m.collected ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="Bar collected" kpi={m.collected} onClick={() => open("source:BAR", "Bar — collected")} testId="kpi-collected" />
        </div>
      ) : null}
      {scope === "SHOP" && m.collected ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="Shop collected" kpi={m.collected} onClick={() => open("source:SHOP", "Shop — collected")} testId="kpi-collected" />
        </div>
      ) : null}
      {scope === "DESK" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {m.courts ? <KpiCard label="Courts collected today" kpi={m.courts} onClick={() => open("source:COURTS", "Courts — collected today")} /> : null}
          {m.social ? <KpiCard label="Social play today" kpi={m.social} onClick={() => open("source:SOCIAL", "Social play — collected today")} /> : null}
          {m.memberships ? <KpiCard label="Memberships today" kpi={m.memberships} onClick={() => open("source:MEMBERSHIP", "Memberships — collected today")} /> : null}
        </div>
      ) : null}

      {/* Owed / owe (R-39) */}
      {d.receivables || d.payables ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {d.receivables ? (
            <button
              type="button"
              onClick={() => open("receivables", "What we are owed — unpaid customer bills")}
              className="rounded-lg border bg-card p-4 text-left shadow-sm hover:border-primary"
            >
              <p className="text-xs font-medium text-muted-foreground">What we are owed (receivables, now)</p>
              <p className="tabular text-2xl font-bold" data-testid="kpi-receivables"><Money paise={d.receivables.total} /></p>
              <p className="text-xs text-muted-foreground">{d.receivables.count} unpaid bill{d.receivables.count === 1 ? "" : "s"}: member dues, pay-at-pickup orders, issued invoices</p>
            </button>
          ) : null}
          {d.payables ? (
            <div className="rounded-lg border bg-card p-4 shadow-sm">
              <p className="text-xs font-medium text-muted-foreground">What we owe (payables)</p>
              <p className="tabular text-2xl font-bold"><Money paise={d.payables.total} /></p>
              <div className="mt-1 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Link href="/app/finance/expenses?status=UNPAID" className="rounded bg-muted p-2 hover:underline">
                  Supplier bills<br /><Money paise={d.payables.expenses} className="font-semibold" />
                </Link>
                <Link href="/app/finance/payroll" className="rounded bg-muted p-2 hover:underline">
                  Approved payroll<br /><Money paise={d.payables.payroll} className="font-semibold" />
                </Link>
                <Link href="/app/finance/gst" className="rounded bg-muted p-2 hover:underline">
                  GST collected (est.)<br /><Money paise={d.payables.gst} className="font-semibold" />
                </Link>
                {/* v4 RF-10: approved refunds waiting at the desk are money we owe until collected. */}
                <Link href="/app/refunds?status=APPROVED&sort=oldest" className="rounded bg-muted p-2 hover:underline" data-testid="payables-refunds">
                  Refunds payable<br /><Money paise={d.payables.refunds ?? 0} className="font-semibold" />
                  {d.payables.refundCount ? (
                    <span className="block text-muted-foreground">
                      {d.payables.refundCount} waiting{d.payables.refundOldestDays != null ? ` · oldest ${d.payables.refundOldestDays} d` : ""}
                    </span>
                  ) : null}
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {d.daily && d.daily.length ? (
        <Section title="Daily revenue by source">
          <DailyRevenueChart data={d.daily} />
        </Section>
      ) : null}

      {/* Operations (R-45) */}
      {d.ops ? <OpsSection d={d} open={open} /> : null}
      <p className="text-right text-[11px] text-muted-foreground">Generated {fmtDateTime(d.generatedAt)} · refreshes every minute</p>
    </div>
  );
}

function OpsSection({ d, open }: { d: Dashboard; open: (metric: string, title: string) => void }) {
  const o = d.ops!;
  return (
    <div className="flex flex-col gap-4">
      {o.bookings || o.utilization ? (
        <Section title="Courts">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {o.bookings ? <KpiCard label="Bookings" kind="count" kpi={o.bookings} onClick={() => open("bookings", "Bookings in the period")} /> : null}
              {o.cancellations ? <KpiCard label="Cancellations" kind="count" invert kpi={o.cancellations} onClick={() => open("cancellations", "Cancelled bookings")} /> : null}
              {o.noShows ? <KpiCard label="No-shows" kind="count" invert kpi={o.noShows} onClick={() => open("noShows", "No-shows")} /> : null}
              {o.clubCancellationsPending !== undefined ? <StatCard label="Club cancellations pending choice" value={o.clubCancellationsPending} href="/app/courts/bookings?resolution=PENDING_CHOICE" /> : null}
              {o.utilization ? (
                <StatCard label="Court utilization" value={`${o.utilization.pct}%`} hint={`${o.utilization.bookedHours} of ${o.utilization.openHours} open court-hours booked`} />
              ) : null}
            </div>
            {o.utilization ? <UtilizationHeatmap hours={o.utilization.heatmap.hours} courts={o.utilization.heatmap.courts} /> : null}
          </div>
        </Section>
      ) : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {o.members ? (
          <Section title="Members">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Active members" value={o.members.activeTotal} />
              <StatCard label="New in period" value={o.members.newMembers} href="/app/members" />
              <StatCard label="Expiring in 7 days" value={o.members.expiringSoon} href="/app/desk/expiring" />
              <div className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm">
                {Object.entries(o.members.activeByTier).map(([tier, n]) => (
                  <span key={tier} className="flex items-center justify-between gap-2">
                    <TierBadge tier={tier} /> <strong className="tabular">{n}</strong>
                  </span>
                ))}
              </div>
            </div>
          </Section>
        ) : null}
        {o.leads ? (
          <Section title="Leads & enquiries">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="New leads" value={o.leads.newLeads} href="/app/crm" />
              <StatCard label="Overdue follow-ups" value={<span className={o.leads.overdue ? "text-destructive" : ""}>{o.leads.overdue}</span>} href="/app/crm" />
              <StatCard label="Won" value={o.leads.won} />
              <StatCard label="Conversion" value={`${o.leads.conversionRate}%`} hint="won ÷ leads created in period" />
            </div>
          </Section>
        ) : null}
        {o.shop ? (
          <Section title="Shop">
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Low-stock items" value={<span className={o.shop.lowStock ? "text-warning-text" : ""}>{o.shop.lowStock}</span>} href="/app/shop/stock?filter=low" />
                <StatCard label="Open online orders" value={o.shop.openOrders} href="/app/shop/orders" />
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top 5 products</p>
                {o.shop.topProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No products sold in this period.</p>
                ) : (
                  <ol className="divide-y rounded-md border text-sm">
                    {o.shop.topProducts.map((p, i) => (
                      <li key={p.name} className="flex items-center justify-between gap-2 p-2">
                        <span>
                          <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                          {p.name}
                        </span>
                        <span className="tabular whitespace-nowrap">
                          {p.qty} sold · <Money paise={p.revenue} />
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </Section>
        ) : null}
        {o.bar ? (
          <Section title="Bar & cafeteria">
            <div className="grid grid-cols-2 gap-3">
              {/* The bar's takings are the "Bar" money tile above (or "Bar collected" on the bar view), not repeated here. */}
              <StatCard label="Average tab" value={<Money paise={o.bar.averageTab} />} hint={`${o.bar.settledTabs} settled tabs`} />
              <StatCard label="Open tabs" value={o.bar.openTabs} href="/app/bar" />
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
