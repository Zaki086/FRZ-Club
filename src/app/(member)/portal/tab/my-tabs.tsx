"use client";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { formatINR } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { cn } from "@/components/ui/cn";

type Line = { id: string; name: string; qty: number; netAmount: number; discountAmount: number; status: string; explanation: string };
type Tab = { id: string; code: string; status: string; tier: string; table: { number: number } | null; total: number; paid: number; due: number; discountTotal: number; openedAt: string; barDate: string; lines: Line[] };

function TabCard({ t, open }: { t: Tab; open?: boolean }) {
  return (
    <Card className={cn(open && "border-warning/50")}>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {open ? "Open tab" : fmtDate(t.barDate)} <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
          {t.table ? <span className="text-sm font-normal text-muted-foreground">Table {t.table.number}</span> : null}
        </CardTitle>
        <span className="flex items-center gap-1"><TierBadge tier={t.tier} /><StatusBadge status={t.status} /></span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="divide-y text-sm">
          {t.lines.map((l) => (
            <div key={l.id} className={cn("flex items-start justify-between gap-2 py-1.5", l.status === "VOID" && "line-through opacity-50")}>
              <div>
                <p>{l.qty} × {l.name}</p>
                <p className="text-xs text-muted-foreground">{l.explanation}</p>
              </div>
              <div className="text-right">
                <Money paise={l.netAmount} />
                {l.discountAmount ? <p className="text-xs text-success-text">−{formatINR(l.discountAmount)}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1 border-t pt-2 text-sm">
          <span className="text-muted-foreground">You saved</span><Money paise={t.discountTotal} className="text-right text-success-text" />
          <span className="text-muted-foreground">Total</span><Money paise={t.total} className="text-right font-semibold" />
          <span className="text-muted-foreground">Paid</span><Money paise={t.paid} className="text-right" />
          <span className="font-semibold">To settle</span><Money paise={t.due} className="text-right font-bold" />
        </div>
        {open ? <p className="text-xs text-muted-foreground">Opened {fmtDateTime(t.openedAt)}. Please settle at the bar before you leave.</p> : null}
      </CardContent>
    </Card>
  );
}

export function MyTabs() {
  const state = useApi<Tab[]>("/api/me/tabs");
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">My bar tab</h1>
      <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No bar tabs yet" }}>
        {(tabs) => {
          const open = tabs.filter((t) => t.status === "OPEN" || t.status === "CARRIED");
          const past = tabs.filter((t) => !(t.status === "OPEN" || t.status === "CARRIED"));
          return (
            <>
              {open.map((t) => <TabCard key={t.id} t={t} open />)}
              {past.length ? <h2 className="mt-2 text-lg font-semibold">History</h2> : null}
              {past.map((t) => <TabCard key={t.id} t={t} />)}
            </>
          );
        }}
      </DataState>
    </div>
  );
}
