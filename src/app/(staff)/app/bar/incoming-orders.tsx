"use client";
// v5 MO-3 (ORDER): "Incoming orders" on the bar screen — member orders from the portal waiting for the bar, with a
// badge, a sound for each new one (once sound is turned on: browsers need a tap first), the waiting time (red after
// `member_order_accept_minutes`), Accept (set or confirm the table → the kitchen, BR-6) and Reject with a reason.
import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, Smartphone, Wine, X } from "lucide-react";
import { api, useApi } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { TierBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { istTime } from "@/lib/time";
import { toRejection, type Rejection } from "./_components/err";

type IncomingOrder = {
  id: string; placedAt: string; waitingMinutes: number; overdue: boolean; member: { id: string; name: string; code: string }; tier: string;
  tab: { id: string; code: string; tableId: string | null }; table: { id: string; number: number; area: string } | null; via: "TABLE" | "CHECKIN"; total: number;
  lines: Array<{ id: string; name: string; qty: number; note: string | null; netAmount: number; status: string; isAlcoholic: boolean; prepMinutes: number | null }>;
};
type Incoming = { acceptMinutes: number; autoAccept: boolean; tables: Array<{ id: string; number: number; area: string }>; orders: IncomingOrder[] };

const REASONS = [
  { value: "ITEM_UNAVAILABLE", label: "Item unavailable" },
  { value: "MEMBER_NOT_FOUND", label: "Member not found at the table" },
  { value: "OTHER", label: "Other" },
] as const;

function chime(ctx: AudioContext) {
  for (const [i, freq] of [660, 990, 1320].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.22, ctx.currentTime + i * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.15);
    osc.stop(ctx.currentTime + i * 0.15 + 0.15);
  }
}

function useOrderSound(orders: IncomingOrder[] | undefined) {
  const [on, setOn] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!orders) return;
    const ids = new Set(orders.map((o) => o.id));
    const fresh = seen.current ? [...ids].some((id) => !seen.current!.has(id)) : false;
    seen.current = ids;
    if (fresh && on && ctx.current) chime(ctx.current);
  }, [orders, on]);
  const toggle = () => {
    const next = !on;
    if (next) {
      ctx.current ??= new AudioContext();
      void ctx.current.resume();
      chime(ctx.current);
    }
    setOn(next);
  };
  return { on, toggle };
}

function OrderCard({ o, tables, onDone }: { o: IncomingOrder; tables: Incoming["tables"]; onDone: () => void }) {
  const [tableId, setTableId] = useState(o.table?.id ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("ITEM_UNAVAILABLE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const live = o.lines.filter((l) => l.status !== "VOID");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border-2 bg-card p-3", o.overdue ? "border-destructive bg-destructive/5" : "border-primary/40")} data-testid="incoming-order" data-overdue={o.overdue}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {o.member.name} <TierBadge tier={o.tier} />
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{o.member.code}</span> · tab <span className="font-mono">{o.tab.code}</span> ·{" "}
            {o.table ? `Table ${o.table.number}` : "no table yet"} · {o.via === "TABLE" ? "scanned the table QR" : "checked in"}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-lg px-2 py-1 text-sm font-bold tabular", o.overdue ? "bg-destructive text-destructive-foreground" : "bg-muted")} title={`Placed at ${istTime(new Date(o.placedAt))}`} data-testid="incoming-wait">
          {o.waitingMinutes}′
        </span>
      </div>
      <ul className="text-sm">
        {o.lines.map((l) => (
          <li key={l.id} className={cn("flex justify-between gap-2 py-0.5", l.status === "VOID" && "line-through opacity-50")}>
            <span>
              <span className="font-semibold">{l.qty}×</span> {l.name} {l.isAlcoholic ? <Wine className="inline h-3 w-3 text-purple-700" aria-label="Alcohol" /> : null}
              {l.note ? <span className="block text-xs font-semibold text-warning-text">“{l.note}”</span> : null}
            </span>
            <Money paise={l.netAmount} className="shrink-0 text-xs" />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t pt-2 text-sm">
        <span className="text-muted-foreground">{live.length ? "Order total" : "Every item was removed"}</span>
        <Money paise={o.total} className="font-semibold" />
      </div>
      {!rejecting ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select className="h-9 w-44" value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label={`Table for ${o.member.name}'s order`}>
            <option value="">No table (counter)</option>
            {tables.map((t) => <option key={t.id} value={t.id}>Table {t.number} · {t.area}</option>)}
          </Select>
          <Button size="sm" disabled={busy || !live.length} onClick={() => run(() => api(`/api/bar/incoming/${o.id}/accept`, { body: { tableId: tableId || null } }))} data-testid="incoming-accept">
            <Check className="h-4 w-4" /> Accept
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)} data-testid="incoming-reject">
            <X className="h-4 w-4" /> Reject
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 p-2">
          <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} aria-label="Reason for rejecting">
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "OTHER" ? "Say why (the member sees this)" : "Optional note for the member"} aria-label="Note for the member" maxLength={200} />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => run(() => api(`/api/bar/incoming/${o.id}/reject`, { body: { reason, note: note.trim() || undefined } }))} data-testid="incoming-reject-confirm">
              Reject order
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Back</Button>
          </div>
        </div>
      )}
      <RejectionBanner error={error} />
    </div>
  );
}

export function IncomingOrders() {
  const state = useApi<Incoming>("/api/bar/incoming", { pollMs: 5000 });
  const sound = useOrderSound(state.data?.orders);
  const d = state.data;
  const count = d?.orders.length ?? 0;
  return (
    <Card className={cn("mb-4", count ? "border-primary" : "")} data-testid="incoming-orders">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5" /> Incoming orders
          <Badge tone={count ? "red" : "neutral"} data-testid="incoming-count" aria-label={`${count} waiting`}>{count}</Badge>
        </CardTitle>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {d ? <span>Members&apos; app orders · red after {d.acceptMinutes} min{d.autoAccept ? " · auto-accept is on for table scans" : ""}</span> : null}
          <Button size="sm" variant="outline" onClick={sound.toggle} aria-pressed={sound.on} data-testid="incoming-sound">
            {sound.on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />} {sound.on ? "Sound on" : "Sound off"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {state.error && !d ? <RejectionBanner error={{ message: state.error.message }} /> : null}
        {!d ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !count ? (
          <p className="text-sm text-muted-foreground">No orders waiting. Orders members place from their phones appear here.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {d.orders.map((o) => <OrderCard key={o.id} o={o} tables={d.tables} onDone={() => void state.reload()} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
