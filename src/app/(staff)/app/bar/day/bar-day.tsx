"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { api, useApi } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { addDays, fmtDate, fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { cn } from "@/components/ui/cn";
import type { MenuItem } from "../_components/types";
import { toRejection, type Rejection } from "../_components/err";

type Report = {
  date: string; collected: number; byMethod: Record<string, number>; byCategory: Record<string, number>;
  byStaff: Array<{ userId: string; name: string; amount: number; shifts: number }>;
  discounts: number; voids: { count: number; amount: number }; tabsOpened: number; tabsSettled: number; averageTab: number;
  openTabs: Array<{ id: string; code: string; due: number }>; carriedTabs: Array<{ id: string; code: string; reason: string | null }>;
  closedAt: string | null;
};

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </Card>
  );
}

function MenuAvailability() {
  const menu = useApi<MenuItem[]>("/api/bar/menu?all=1");
  const [error, setError] = useState<Rejection>(null);
  return (
    <Card>
      <CardHeader><CardTitle>Menu availability</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <RejectionBanner error={error} />
        <DataState state={menu} isEmpty={(d) => d.length === 0} empty={{ title: "No menu items" }}>
          {(items) => (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cn("flex items-center justify-between rounded-md border p-2 text-left text-sm", m.available ? "bg-card" : "bg-red-50 text-red-900")}
                  onClick={async () => {
                    setError(null);
                    try {
                      await api(`/api/bar/menu/${m.id}`, { method: "PATCH", body: { available: !m.available } });
                      await menu.reload();
                    } catch (e) {
                      setError(toRejection(e));
                    }
                  }}
                >
                  <span>{m.name} <span className="text-xs text-muted-foreground">{formatINR(m.price)}</span></span>
                  <span className="text-xs font-semibold">{m.available ? "Available" : "Sold out"}</span>
                </button>
              ))}
            </div>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

type DayRow = {
  id: string; status: "OPEN" | "CLOSED"; closed_at: string | null; closed_by_name: string | null; tabs_opened: number; tabs_settled: number;
  tabs_carried: number; tabs_open: number; blocking: number; collected: number; variance: number | null; drawers: number;
};

function CloseDayButton({ date, onClosed }: { date: string; onClosed: () => void }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  return (
    <span className="flex flex-col items-start gap-1" onClick={(e) => e.stopPropagation()}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api("/api/bar/day/close", { body: { date } });
            reload();
            onClosed();
          } catch (e) {
            setError(toRejection(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Lock className="h-3.5 w-3.5" /> Close day
      </Button>
      <RejectionBanner error={error} />
    </span>
  );
}

/** v3 §3.2: every bar day with the standard FilterBar; picking a row shows that day's report above. */
function BarDaysList({ selected, onPick, canClose, onClosed }: { selected: string; onPick: (date: string) => void; canClose: boolean; onClosed: (date: string) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>All bar days</CardTitle></CardHeader>
      <CardContent>
        <FilteredList<DayRow>
          list="bar-days"
          searchPlaceholder="Date (YYYY-MM-DD) or who closed it"
          pollMs={60_000}
          onRowClick={(r) => onPick(r.id)}
          columns={[
            { key: "day", header: "Bar day", cell: (r) => (
              <span className="flex flex-col">
                <span className={cn("font-semibold", r.id === selected && "text-primary")}>{fmtDate(r.id)}</span>
                <RelTime when={r.id} className="text-xs text-muted-foreground" />
              </span>
            ) },
            { key: "collected", header: "Collected", className: "text-right", cell: (r) => <Money paise={r.collected} /> },
            { key: "tabs", header: "Tabs", cell: (r) => (
              <span className="text-sm">{r.tabs_opened} opened · {r.tabs_settled} settled{r.tabs_carried ? ` · ${r.tabs_carried} carried` : ""}{r.tabs_open ? ` · ${r.tabs_open} open` : ""}</span>
            ) },
            { key: "variance", header: "Bar drawer variance", className: "text-right", cell: (r) => (
              r.variance === null ? <span className="text-muted-foreground">—</span> : r.variance === 0 ? <Badge tone="green">None</Badge> : <Badge tone="red">{r.variance > 0 ? "Over" : "Short"} <Money paise={Math.abs(r.variance)} /></Badge>
            ) },
            { key: "status", header: "Status", cell: (r) => (
              r.status === "CLOSED"
                ? <span className="flex flex-col items-start gap-0.5"><Badge tone="green">Closed</Badge>{r.closed_by_name ? <span className="text-xs text-muted-foreground">by {r.closed_by_name}</span> : null}</span>
                : <Badge tone="amber">Not closed</Badge>
            ) },
            { key: "next", header: "Next", cell: (r) => {
              if (r.status === "CLOSED") return <RelTime when={r.closed_at} className="text-xs text-muted-foreground" />;
              if (r.blocking > 0) return <span className="text-sm font-semibold text-primary">Settle or carry {r.blocking} open tab{r.blocking === 1 ? "" : "s"} ↑</span>;
              return canClose ? <CloseDayButton date={r.id} onClosed={() => onClosed(r.id)} /> : <span className="text-xs text-muted-foreground">Ready to close</span>;
            } },
          ]}
          empty={{ title: "No bar days match these filters" }}
        />
      </CardContent>
    </Card>
  );
}

export function BarDay({ today, perms }: { today: string; perms: { close: boolean; operate: boolean } }) {
  const [date, setDate] = useState(today);
  const state = useApi<Report>(`/api/bar/day?date=${date}`);
  const [error, setError] = useState<Rejection>(null);
  const [busy, setBusy] = useState(false);
  // Closing the day above refreshes the list below (and the other way round).
  const [listKey, setListKey] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Input type="date" className="w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <Button variant="outline" size="icon" aria-label="Next day" onClick={() => setDate(addDays(date, 1))}><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" onClick={() => setDate(today)}>Today</Button>
        <span className="text-sm text-muted-foreground">{fmtDate(date)}</span>
      </div>
      <RejectionBanner error={error} />
      <DataState state={state}>
        {(r) => (
          <>
            {r.closedAt ? (
              <p className="flex items-center gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm"><Lock className="h-4 w-4" /> Day closed {fmtDateTime(r.closedAt)}.</p>
            ) : perms.close ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-3">
                <p className="text-sm">{r.openTabs.length ? `${r.openTabs.length} tab(s) still open — settle or carry them over before closing.` : "All tabs are settled or carried over."}</p>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api("/api/bar/day/close", { body: { date } });
                      await state.reload();
                      setListKey((k) => k + 1);
                    } catch (e) {
                      setError(toRejection(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Lock className="h-4 w-4" /> Close bar day
                </Button>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
              <Kpi label="Collected (net)" value={<Money paise={r.collected} />} />
              <Kpi label="Tabs opened" value={r.tabsOpened} />
              <Kpi label="Tabs settled" value={r.tabsSettled} />
              <Kpi label="Average tab" value={<Money paise={r.averageTab} />} />
              <Kpi label="Discounts given" value={<Money paise={r.discounts} />} />
              <Kpi label="Voids" value={<>{r.voids.count} · <Money paise={r.voids.amount} /></>} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader><CardTitle>By payment method</CardTitle></CardHeader>
                <CardContent>
                  <Table><TBody>{Object.entries(r.byMethod).map(([k, v]) => <TR key={k}><TD>{k}</TD><TD className="text-right"><Money paise={v} /></TD></TR>)}</TBody></Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>By category (tabs of the day)</CardTitle></CardHeader>
                <CardContent>
                  <Table><TBody>{Object.entries(r.byCategory).map(([k, v]) => <TR key={k}><TD>{k.charAt(0) + k.slice(1).toLowerCase()}</TD><TD className="text-right"><Money paise={v} /></TD></TR>)}</TBody></Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>By staff</CardTitle></CardHeader>
                <CardContent>
                  {r.byStaff.length === 0 ? <p className="text-sm text-muted-foreground">No bar payments taken.</p> : (
                    <Table><THead><TR><TH>Staff</TH><TH>Shifts</TH><TH className="text-right">Taken</TH></TR></THead>
                      <TBody>{r.byStaff.map((s) => <TR key={s.userId}><TD>{s.name}</TD><TD>{s.shifts}</TD><TD className="text-right"><Money paise={s.amount} /></TD></TR>)}</TBody></Table>
                  )}
                </CardContent>
              </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Open tabs</CardTitle></CardHeader>
                <CardContent>
                  {r.openTabs.length === 0 ? <p className="text-sm text-muted-foreground">No open tabs.</p> : (
                    <div className="divide-y">
                      {r.openTabs.map((t) => (
                        <div key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                          {perms.operate ? <Link className="font-mono text-primary hover:underline" href={`/app/bar/tabs/${t.id}`}>{t.code}</Link> : <span className="font-mono">{t.code}</span>}
                          <span className="flex items-center gap-2">
                            <Money paise={t.due} />
                            {perms.close && !r.closedAt ? (
                              <ConfirmButton
                                trigger="Carry over"
                                title={`Carry tab ${t.code} over?`}
                                description="The tab stays payable later; the reason is audited (BR-9)."
                                requireReason
                                variant="outline"
                                confirmLabel="Carry over"
                                onConfirm={async (reason) => { await api(`/api/bar/tabs/${t.id}/carry`, { body: { reason } }); await state.reload(); setListKey((k) => k + 1); }}
                              />
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Carried over</CardTitle></CardHeader>
                <CardContent>
                  {r.carriedTabs.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
                    <div className="divide-y">{r.carriedTabs.map((t) => <p key={t.id} className="py-2 text-sm"><span className="font-mono">{t.code}</span> — {t.reason}</p>)}</div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </DataState>
      <BarDaysList
        key={listKey}
        selected={date}
        canClose={perms.close}
        onPick={(d) => {
          setDate(d);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        onClosed={(d) => {
          if (d === date) void state.reload();
        }}
      />
      {perms.operate ? <MenuAvailability /> : null}
    </div>
  );
}
