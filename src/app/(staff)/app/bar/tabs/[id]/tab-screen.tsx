"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ChefHat, Minus, Plus, ShieldCheck, Wine } from "lucide-react";
import { api, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { cn } from "@/components/ui/cn";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { SettleDialog } from "../../_components/settle-dialog";
import type { MenuItem, TablesData, TabLine, TabView } from "../../_components/types";
import { toRejection, type Rejection } from "../../_components/err";

type Pending = { menuItemId: string; name: string; isAlcoholic: boolean; qty: number; note: string };
const CATS: Array<MenuItem["category"]> = ["FOOD", "BEVERAGE", "ALCOHOL"];
const CAT_LABEL: Record<MenuItem["category"], string> = { FOOD: "Food", BEVERAGE: "Drinks", ALCOHOL: "Alcohol" };

type OpenTab = { id: string; code?: string; payer: string; status: string; table?: number | null };

function LineRow({ line, perms, onDone, otherTabs }: { line: TabLine; perms: { manager: boolean }; onDone: () => void; otherTabs: OpenTab[] }) {
  const [error, setError] = useState<Rejection>(null);
  const [moveTo, setMoveTo] = useState("");
  const voidable = line.status !== "VOID" && line.status !== "SERVED";
  const needsManager = line.status !== "NEW";
  return (
    <div className={cn("flex flex-col gap-1 py-2", line.status === "VOID" && "opacity-50")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("font-medium", line.status === "VOID" && "line-through")}>
            {line.qty} × {line.name} {line.isAlcoholic ? <Wine className="inline h-3 w-3 text-purple-700" /> : null}
          </p>
          <p className="text-xs text-muted-foreground">{line.explanation}{line.note ? ` · note: ${line.note}` : ""}</p>
          {line.voidReason ? <p className="text-xs text-destructive">Void: {line.voidReason}</p> : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Money paise={line.netAmount} className="font-semibold" />
          {line.discountAmount ? <span className="text-xs text-green-700">−{formatINR(line.discountAmount)} ({line.discountPct}%)</span> : null}
          <span className="flex gap-1">
            {!line.sent && line.status === "NEW" ? <Badge tone="neutral">not sent</Badge> : null}
            <StatusBadge status={line.status} />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {line.status === "READY" ? (
          <Button
            size="sm"
            onClick={async () => {
              setError(null);
              try { await api(`/api/bar/lines/${line.id}/status`, { body: { status: "SERVED" } }); onDone(); }
              catch (e) { setError(toRejection(e)); }
            }}
          >
            Mark served
          </Button>
        ) : null}
        {voidable && (!needsManager || perms.manager) ? (
          <ConfirmButton
            trigger="Void"
            title={`Void ${line.qty} × ${line.name}?`}
            description={needsManager ? "Already in the kitchen — manager void, reason is audited (BR-7)." : "Not yet being prepared. Give a short reason."}
            requireReason
            confirmLabel="Void item"
            onConfirm={async (reason) => { await api(`/api/bar/lines/${line.id}/void`, { body: { reason } }); onDone(); }}
          />
        ) : null}
        {voidable && needsManager && !perms.manager ? <span className="text-xs text-muted-foreground">Manager needed to void</span> : null}
        {line.status !== "VOID" && otherTabs.length ? (
          <span className="inline-flex gap-1">
            <Select className="h-8 w-40 text-xs" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move item to tab">
              <option value="">Move to tab…</option>
              {otherTabs.map((t) => (
                <option key={t.id} value={t.id}>{t.payer}{t.table ? ` · T${t.table}` : ""}</option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={!moveTo}
              onClick={async () => {
                setError(null);
                try { await api(`/api/bar/lines/${line.id}/transfer`, { body: { toTabId: moveTo } }); setMoveTo(""); onDone(); }
                catch (e) { setError(toRejection(e)); }
              }}
            >
              Move
            </Button>
          </span>
        ) : null}
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function TabScreen({ tabId, perms }: { tabId: string; perms: { manager: boolean } }) {
  const tab = useApi<TabView>(`/api/bar/tabs/${tabId}`, { pollMs: 10000 });
  const menu = useApi<MenuItem[]>("/api/bar/menu");
  const openTabs = useApi<OpenTab[]>("/api/bar/tabs");
  const tables = useApi<TablesData>("/api/bar/tables");
  const [cat, setCat] = useState<MenuItem["category"]>("BEVERAGE");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const reload = () => void tab.reload();

  const addPending = (m: MenuItem) => {
    setPending((p) => {
      const i = p.findIndex((x) => x.menuItemId === m.id && !x.note);
      if (i >= 0) return p.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x));
      return [...p, { menuItemId: m.id, name: m.name, isAlcoholic: m.isAlcoholic, qty: 1, note: "" }];
    });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await tab.reload(); }
    catch (e) { setError(toRejection(e)); }
    finally { setBusy(false); }
  };

  return (
    <DataState state={tab}>
      {(t) => {
        const editable = t.status === "OPEN";
        const unsent = t.lines.filter((l) => l.status === "NEW" && !l.sent).length;
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="ghost" size="sm"><Link href="/app/bar"><ArrowLeft className="h-4 w-4" /> Tables</Link></Button>
              <h1 className="text-2xl font-bold">{t.payer}</h1>
              <TierBadge tier={t.tier} />
              <span className="font-mono text-sm text-muted-foreground">{t.code}</span>
              <StatusBadge status={t.status} />
              {t.guestId ? (t.guestIdVerified ? <Badge tone="green"><ShieldCheck className="mr-1 h-3 w-3" />ID verified 18+</Badge> : <Badge tone="amber">ID not verified</Badge>) : null}
              <span className="text-sm text-muted-foreground">Opened {fmtDateTime(t.openedAt)}</span>
            </div>
            {t.carriedReason ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">Carried over: {t.carriedReason}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">Table:</span>
              <Select
                className="w-48"
                value={t.table?.id ?? ""}
                disabled={!editable || busy}
                onChange={(e) => run(() => api(`/api/bar/tabs/${t.id}/move`, { body: { tableId: e.target.value || null } }))}
                aria-label="Table"
              >
                <option value="">No table (counter)</option>
                {(tables.data?.tables ?? []).map((tb) => <option key={tb.id} value={tb.id}>Table {tb.number} · {tb.area}</option>)}
              </Select>
              {t.guestId && !t.guestIdVerified && editable ? (
                <Button variant="outline" disabled={busy} onClick={() => run(() => api(`/api/bar/tabs/${t.id}/verify-id`, { body: {} }))}>
                  <ShieldCheck className="h-4 w-4" /> Verify ID 18+
                </Button>
              ) : null}
            </div>

            <RejectionBanner error={error} />

            <div className="grid gap-4 xl:grid-cols-5">
              {editable ? (
                <Card className="xl:col-span-3">
                  <CardHeader className="pb-2">
                    <div className="flex gap-2">
                      {CATS.map((c) => (
                        <Button key={c} size="lg" variant={cat === c ? "default" : "outline"} onClick={() => setCat(c)} className="flex-1">
                          {c === "ALCOHOL" ? <Wine className="h-4 w-4" /> : null}{CAT_LABEL[c]}
                        </Button>
                      ))}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <DataState state={menu} isEmpty={(d) => d.length === 0} empty={{ title: "The menu is empty" }}>
                      {(items) => (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                          {items.filter((m) => m.category === cat).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => addPending(m)}
                              className={cn(
                                "flex min-h-20 flex-col justify-between rounded-lg border-2 p-3 text-left transition-colors active:scale-[0.98]",
                                m.isAlcoholic ? "border-purple-200 bg-purple-50 hover:border-purple-500" : "border-border bg-card hover:border-primary",
                              )}
                              data-testid="menu-item"
                            >
                              <span className="font-semibold leading-tight">{m.name}</span>
                              <span className="text-sm text-muted-foreground">{formatINR(m.price)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </DataState>
                    {pending.length ? (
                      <div className="mt-4 flex flex-col gap-2 rounded-lg border-2 border-primary/40 bg-accent/30 p-3">
                        <p className="text-sm font-semibold">New order (priced by the server when added)</p>
                        {pending.map((p, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Button size="icon" variant="outline" aria-label="Less" onClick={() => setPending(pending.flatMap((x, j) => (j === i ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x])))}>
                              <Minus className="h-4 w-4" />
                            </Button>
                            <span className="w-6 text-center font-bold">{p.qty}</span>
                            <Button size="icon" variant="outline" aria-label="More" onClick={() => setPending(pending.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))}>
                              <Plus className="h-4 w-4" />
                            </Button>
                            <span className="flex-1 truncate font-medium">{p.name}</span>
                            <Input className="h-9 w-40" placeholder="Seat / note" value={p.note} onChange={(e) => setPending(pending.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
                          </div>
                        ))}
                        <div className="flex gap-2">
                          <Button
                            size="lg"
                            className="flex-1"
                            disabled={busy}
                            data-testid="add-to-tab"
                            onClick={() => run(async () => {
                              await api(`/api/bar/tabs/${t.id}/lines`, { body: { items: pending.map((p) => ({ menuItemId: p.menuItemId, qty: p.qty, note: p.note || undefined })) } });
                              setPending([]);
                            })}
                          >
                            Add to tab
                          </Button>
                          <Button size="lg" variant="ghost" onClick={() => setPending([])}>Clear</Button>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}

              <Card className={editable ? "xl:col-span-2" : "xl:col-span-5"}>
                <CardHeader><CardTitle>Tab lines</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {t.lines.length === 0 ? <p className="text-sm text-muted-foreground">Nothing ordered yet — tap items on the left.</p> : (
                    <div className="divide-y">{t.lines.map((l) => <LineRow key={l.id} line={l} perms={perms} onDone={reload} otherTabs={(openTabs.data ?? []).filter((o) => o.id !== t.id && o.status === "OPEN")} />)}</div>
                  )}
                  {editable ? (
                    <Button size="lg" variant="outline" disabled={busy || unsent === 0} onClick={() => run(() => api(`/api/bar/tabs/${t.id}/send`, { body: {} }))} data-testid="send-kitchen">
                      <ChefHat className="h-5 w-5" /> Send to kitchen{unsent ? ` (${unsent})` : ""}
                    </Button>
                  ) : null}
                  <div className="grid grid-cols-2 gap-1 border-t pt-2 text-sm">
                    <span className="text-muted-foreground">Discounts</span><Money paise={t.discountTotal} className="text-right text-green-700" />
                    <span className="text-muted-foreground">Total</span><Money paise={t.total} className="text-right font-semibold" />
                    <span className="text-muted-foreground">Paid</span><Money paise={t.paid} className="text-right" />
                    <span className="font-semibold">Due</span><Money paise={t.due} className="text-right text-xl font-bold" />
                  </div>
                  {t.status === "OPEN" || t.status === "CARRIED" ? (
                    <div className="flex flex-col gap-2">
                      <SettleDialog tabId={t.id} tabCode={t.code} due={t.due} onDone={reload} />
                      <Button asChild variant="outline"><a href={`/print/bill/${t.billId}`} target="_blank" rel="noreferrer">Print bill</a></Button>
                      {t.due === 0 ? (
                        <Button size="lg" variant="outline" disabled={busy} onClick={() => run(() => api(`/api/bar/tabs/${t.id}/close`, { body: {} }))}>Close tab</Button>
                      ) : null}
                      {perms.manager && t.status === "OPEN" ? (
                        <ConfirmButton
                          trigger="Carry over to another day"
                          title={`Carry tab ${t.code} over?`}
                          description="Managers only (BR-9). The tab stays payable; the reason is audited."
                          requireReason
                          variant="outline"
                          confirmLabel="Carry over"
                          onConfirm={async (reason) => { await api(`/api/bar/tabs/${t.id}/carry`, { body: { reason } }); reload(); }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </div>
        );
      }}
    </DataState>
  );
}
