"use client";
// v4 RN-5 Front desk: my drawer, arrivals in the next 2 hours, check-in risks, refunds ready to pay out, renewals due
// this week, messages to send and my overdue leads. Every number opens its list (a screen on the desk's menu).
import Link from "next/link";
import { useEffect } from "react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Money } from "@/components/money";
import { DRAWER_CHANGED_EVENT } from "@/components/drawer-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime, fmtRange } from "@/lib/time";

type F = { value: number; href: string };
type Desk = {
  generatedAt: string;
  drawer: { name: string | null; balancePaise: number | null; href: string };
  arrivals: F & { sessions: number; items: Array<{ key: string; title: string; startAt: string; endAt: string; people: string[]; checkedIn: number; total: number; href: string }> };
  risks: F & { soon: number };
  refundsReady: F & { amountPaise: number; oldestDays: number | null };
  renewals: F;
  messagesToSend: F | null;
  overdueLeads: F | null;
};

function Tile({ label, href, testId, warn, children }: { label: string; href: string; testId: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} data-testid={testId} className={`flex flex-col rounded-2xl border bg-card p-3 shadow-soft transition hover:-translate-y-px hover:border-primary ${warn ? "border-warning/60 bg-warning/10" : ""}`}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="font-display text-2xl font-bold tabular">{children}</span>
    </Link>
  );
}

export function FrontDeskDashboard() {
  const state = useApi<Desk>("/api/dashboards/front-desk", { pollMs: 30_000 });
  const { reload } = state;
  // The drawer figure follows every cash payment / refund at once (CD-1), like the header badge.
  useEffect(() => {
    const again = () => void reload();
    window.addEventListener(DRAWER_CHANGED_EVENT, again);
    return () => window.removeEventListener(DRAWER_CHANGED_EVENT, again);
  }, [reload]);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4" data-testid="front-desk-dashboard">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label={d.drawer.name ? `${d.drawer.name} — cash now` : "My cash drawer"} href={d.drawer.href} testId="fd-drawer" warn={d.drawer.balancePaise === null}>
              {d.drawer.balancePaise === null ? <span className="text-base text-destructive">Not open</span> : <Money paise={d.drawer.balancePaise} />}
            </Tile>
            <Tile label="Arriving in the next 2 hours" href={d.arrivals.href} testId="fd-arrivals">{d.arrivals.value}</Tile>
            <Tile label="Check-in risks" href={d.risks.href} testId="fd-risks" warn={d.risks.value > 0}>
              {d.risks.value}
              {d.risks.value ? <span className="ml-1 text-xs font-normal text-muted-foreground">({d.risks.soon} in 2 h)</span> : null}
            </Tile>
            <Tile label="Refunds ready to pay out" href={d.refundsReady.href} testId="fd-refunds" warn={d.refundsReady.value > 0}>
              {d.refundsReady.value}
              {d.refundsReady.value ? <span className="ml-1 text-xs font-normal text-muted-foreground">(<Money paise={d.refundsReady.amountPaise} />)</span> : null}
            </Tile>
            <Tile label="Renewals due this week" href={d.renewals.href} testId="fd-renewals">{d.renewals.value}</Tile>
            {d.messagesToSend ? <Tile label="Messages to send" href={d.messagesToSend.href} testId="fd-messages" warn={d.messagesToSend.value > 0}>{d.messagesToSend.value}</Tile> : null}
            {d.overdueLeads ? <Tile label="My overdue leads" href={d.overdueLeads.href} testId="fd-leads" warn={d.overdueLeads.value > 0}>{d.overdueLeads.value}</Tile> : null}
          </div>
          <Card>
            <CardHeader><CardTitle>Arriving in the next 2 hours</CardTitle></CardHeader>
            <CardContent>
              {d.arrivals.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody due in the next 2 hours.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {d.arrivals.items.map((a) => (
                    <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Link href={a.href} className="hover:underline">
                        <span className="font-medium">{fmtRange(a.startAt, a.endAt)}</span> · {a.title}
                        {a.people.length ? <span className="text-muted-foreground"> · {a.people.join(", ")}</span> : null}
                      </Link>
                      <span className="text-xs text-muted-foreground">{a.checkedIn}/{a.total} checked in</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <p className="text-right text-[11px] text-muted-foreground">Generated {fmtDateTime(d.generatedAt)} · refreshes every 30 seconds</p>
        </div>
      )}
    </DataState>
  );
}
