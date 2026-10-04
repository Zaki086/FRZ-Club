"use client";
// v5 §1.2–1.3 (ORDER): "Bar & Café" — the menu with the member's own prices (MenuView), a cart with a note per line, and
// "My tab": the open tab's lines with their kitchen status, the running total and "Settle at the bar before you leave"
// (MO-7), plus past tabs. Ordering needs a table QR scan or a check-in today (MO-1); the server re-prices every order.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Minus, Plus, ShoppingBag, Wine } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { MenuView, FoodTypeSymbol, type MenuViewCategory } from "@/components/menu-view";
import { Money } from "@/components/money";
import { DataState, RejectionBanner } from "@/components/states";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { formatINR } from "@/lib/money";
import { fmtDate, fmtDateTime, istTime } from "@/lib/time";
import { useBarCart } from "./bar-cart";

type Line = {
  id: string; name: string; isAlcoholic: boolean; foodType: "VEG" | "NON_VEG" | "EGG" | null; qty: number; note: string | null; netAmount: number;
  discountAmount: number; explanation: string; status: "NEW" | "PREPARING" | "READY" | "SERVED" | "VOID"; source: "APP" | "STAFF";
  waitingForBar: boolean; cancellable: boolean; voidReason: string | null;
};
type MyBar = {
  member: { id: string; name: string; onBehalf: boolean };
  family: Array<{ id: string; name: string }>;
  ordering: {
    atClub: boolean; via: "TABLE" | "CHECKIN" | null; table: { id: string; number: number; area: string } | null; scanValidUntil: string | null;
    message: string | null; autoAccept: boolean; tabLimit: number;
  };
  openTab: null | {
    id: string; code: string; table: { id: string; number: number } | null; openedAt: string; total: number; paid: number; due: number; discountTotal: number;
    settleNote: string; lines: Line[];
    orders: Array<{ id: string; placedAt: string; status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED"; total: number; rejectReason: string | null }>;
  };
  carried: Array<{ id: string; code: string; barDate: string; total: number; due: number; reason: string | null }>;
  owed: number;
  past: Array<{ id: string; code: string; barDate: string; settledAt: string | null; total: number; discountTotal: number; billId: string }>;
};
type MemberMenu = { categories: MenuViewCategory[]; tier: string; alcoholHidden: boolean; member: { id: string; name: string } | null };

const LINE_LABEL: Record<Line["status"], string> = { NEW: "New", PREPARING: "Preparing", READY: "Ready", SERVED: "Served", VOID: "Removed" };

function OrderingStatus({ o }: { o: MyBar["ordering"] }) {
  if (!o.atClub) {
    return (
      <div role="status" className="rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm" data-testid="not-at-club">
        <p className="font-semibold">{o.message}</p>
        <p className="mt-1 text-muted-foreground">You can still browse the menu and fill your cart.</p>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm" data-testid="ordering-status">
      <MapPin className="mt-0.5 h-4 w-4 text-success-text" />
      {o.via === "TABLE" && o.table ? (
        <p>
          <span className="font-semibold">You&apos;re at table {o.table.number}</span> ({o.table.area}). Order here and the bar brings it to you
          {o.scanValidUntil ? <> — ordering open until {istTime(new Date(o.scanValidUntil))}</> : null}.
        </p>
      ) : (
        <p><span className="font-semibold">You&apos;re checked in.</span> Order here; scan the QR on your table so the bar knows where to bring it.</p>
      )}
    </div>
  );
}

function Cart({ memberId, menu, ordering, onPlaced }: { memberId: string; menu: MemberMenu; ordering: MyBar["ordering"]; onPlaced: (msg: string) => void }) {
  const cart = useBarCart(memberId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  // One key per cart submission: a retry after a network error places the order once.
  const key = useRef<string | null>(null);
  const items = useMemo(() => new Map(menu.categories.flatMap((c) => c.items).map((i) => [i.id, i])), [menu]);
  const { keepOnly } = cart;
  useEffect(() => keepOnly(new Set(items.keys())), [items, keepOnly]);
  const estimate = cart.lines.reduce((a, l) => a + (items.get(l.menuItemId)?.price ?? 0) * l.qty, 0);
  if (!cart.lines.length) {
    return (
      <Card data-testid="bar-cart">
        <CardHeader><CardTitle className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" /> Your order</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Tap “Add” on the menu to start an order.</p></CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="bar-cart" className="border-primary/40">
      <CardHeader><CardTitle className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" /> Your order</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-3">
          {cart.lines.map((l, i) => {
            const item = items.get(l.menuItemId);
            return (
              <li key={`${l.menuItemId}-${i}`} className="flex flex-col gap-1.5 border-b pb-3 last:border-0" data-testid="cart-line">
                <div className="flex items-center gap-2">
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`One less ${l.name}`} onClick={() => cart.setQty(i, l.qty - 1)}><Minus className="h-4 w-4" /></Button>
                  <span className="w-6 text-center font-bold tabular">{l.qty}</span>
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`One more ${l.name}`} onClick={() => cart.setQty(i, l.qty + 1)}><Plus className="h-4 w-4" /></Button>
                  <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                  {item ? <Money paise={item.price * l.qty} className="text-sm" /> : null}
                </div>
                <Input value={l.note} onChange={(e) => cart.setNote(i, e.target.value)} placeholder="Note for the bar, e.g. no ice" aria-label={`Note for ${l.name}`} maxLength={120} className="h-9" />
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between border-t pt-2 text-sm">
          <span className="text-muted-foreground">Estimated total (your prices)</span>
          <Money paise={estimate} className="font-semibold" />
        </div>
        <p className="text-xs text-muted-foreground">Added to your bar tab — you pay at the bar. The bar&apos;s till confirms the final price.</p>
        <RejectionBanner error={error} />
        <Button
          size="lg"
          disabled={busy || !ordering.atClub}
          data-testid="place-order"
          onClick={async () => {
            setBusy(true);
            setError(null);
            key.current ??= newIdempotencyKey();
            try {
              const r = await api<{ status: "PENDING" | "ACCEPTED"; total: number; table: number | null }>("/api/portal/bar/orders", {
                body: { forMemberId: memberId, items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, note: l.note.trim() || undefined })) },
                idempotencyKey: key.current,
              });
              key.current = null;
              cart.clear();
              onPlaced(r.status === "ACCEPTED" ? `Order sent to the kitchen (${formatINR(r.total)}).` : `Order sent to the bar (${formatINR(r.total)}) — waiting for the bar to accept it.`);
            } catch (e) {
              // A rejected order (not at the club, tab limit, alcohol, sold out) is final for this key: the next try is new.
              if (e instanceof ApiError && e.status !== 0) key.current = null;
              setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          Send order to the bar
        </Button>
      </CardContent>
    </Card>
  );
}

function LineRow({ l, onCancelled }: { l: Line; onCancelled: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <li className={cn("flex flex-col gap-1 py-2", l.status === "VOID" && "opacity-60")} data-testid="tab-line" data-status={l.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("flex items-center gap-1.5 font-medium", l.status === "VOID" && "line-through")}>
            <FoodTypeSymbol type={l.foodType} size={12} />
            {l.qty} × {l.name}
            {l.isAlcoholic ? <Wine className="h-3 w-3 text-purple-700" aria-label="Contains alcohol" /> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {l.explanation}
            {l.note ? ` · “${l.note}”` : ""}
            {l.source === "STAFF" ? " · added at the bar" : ""}
          </p>
          {l.status === "VOID" && l.voidReason ? <p className="text-xs text-destructive">{l.voidReason}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Money paise={l.netAmount} className="text-sm font-semibold" />
          {l.waitingForBar ? <Badge tone="amber">Waiting for the bar</Badge> : <StatusBadge status={l.status} label={LINE_LABEL[l.status]} />}
        </div>
      </div>
      {l.cancellable ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Cancel ${l.name}`}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/api/portal/bar/lines/${l.id}/cancel`, { body: {} });
                onCancelled();
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      <RejectionBanner error={error} />
    </li>
  );
}

function MyTab({ d, reload }: { d: MyBar; reload: () => void }) {
  const t = d.openTab;
  const rejected = t?.orders.filter((o) => o.status === "REJECTED") ?? [];
  return (
    <Card data-testid="my-open-tab" className={cn(t && "border-warning/50")}>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2">
          My tab {t ? <span className="font-mono text-xs text-muted-foreground">{t.code}</span> : null}
          {t?.table ? <span className="text-sm font-normal text-muted-foreground">Table {t.table.number}</span> : null}
        </CardTitle>
        {t ? <StatusBadge status="OPEN" /> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!t ? (
          <p className="text-sm text-muted-foreground">No open tab. Your first order opens one; you settle it at the bar.</p>
        ) : (
          <>
            {rejected.map((o) => (
              <p key={o.id} role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Order of {fmtDateTime(o.placedAt)} not accepted{o.rejectReason ? `: ${o.rejectReason}` : ""}.
              </p>
            ))}
            {t.lines.length ? (
              <ul className="divide-y">{t.lines.map((l) => <LineRow key={l.id} l={l} onCancelled={reload} />)}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing on the tab yet.</p>
            )}
            <div className="grid grid-cols-2 gap-1 border-t pt-2 text-sm">
              {t.discountTotal ? <><span className="text-muted-foreground">You saved</span><Money paise={t.discountTotal} className="text-right text-success-text" /></> : null}
              <span className="text-muted-foreground">Total</span><Money paise={t.total} className="text-right font-semibold" />
              {t.paid ? <><span className="text-muted-foreground">Paid</span><Money paise={t.paid} className="text-right" /></> : null}
            </div>
            <div className="flex items-center justify-between rounded-xl bg-ink px-4 py-3 text-ink-foreground" data-testid="settle-note">
              <span className="font-semibold">{t.settleNote}</span>
              <Money paise={t.due} className="text-xl font-bold" />
            </div>
          </>
        )}
        {d.carried.map((c) => (
          <p key={c.id} className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            Tab {c.code} from {fmtDate(c.barDate)} still has <span className="font-semibold">{formatINR(c.due)}</span> to settle at the bar.
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function PastTabs({ past }: { past: MyBar["past"] }) {
  if (!past.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Past tabs</CardTitle></CardHeader>
      <CardContent>
        <ul className="divide-y text-sm" data-testid="past-tabs">
          {past.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                {fmtDate(p.barDate)} <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                {p.discountTotal ? <span className="ml-2 text-xs text-success-text">saved {formatINR(p.discountTotal)}</span> : null}
              </span>
              <span className="flex items-center gap-3">
                <Money paise={p.total} className="font-semibold" />
                <Link href={`/portal/receipts/${p.billId}`} className="text-xs font-semibold text-primary underline-offset-4 hover:underline">Receipt</Link>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function BarCafe() {
  const params = useSearchParams();
  const [forId, setForId] = useState<string | null>(null);
  const q = forId ? `?for=${encodeURIComponent(forId)}` : "";
  const bar = useApi<MyBar>(`/api/portal/bar${q}`, { pollMs: 10_000 });
  const menu = useApi<MemberMenu>(`/api/portal/bar/menu${q}`, { pollMs: 60_000 });
  const memberId = bar.data?.member.id ?? null;
  const cart = useBarCart(memberId);
  const [notice, setNotice] = useState<string | null>(params.get("table") ? `Table ${params.get("table")} scanned — you can order now.` : null);
  const ordering = bar.data?.ordering;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Bar &amp; Café</h1>
          <p className="text-sm text-muted-foreground">Order from your table — it goes on your bar tab, and your member discount is applied automatically.</p>
        </div>
        {bar.data?.family.length ? (
          <label className="flex items-center gap-2 text-sm font-semibold">
            Ordering for
            <Select aria-label="Ordering for" value={forId ?? bar.data.family[0].id} onChange={(e) => setForId(e.target.value === bar.data!.family[0].id ? null : e.target.value)} className="w-48">
              {bar.data.family.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </label>
        ) : null}
      </div>
      {notice ? <p role="status" className="rounded-xl bg-success/10 px-4 py-2 text-sm font-semibold text-success-text" data-testid="bar-notice">{notice}</p> : null}
      {ordering ? <OrderingStatus o={ordering} /> : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <DataState state={menu}>
            {(m) => (
              <MenuView
                categories={m.categories}
                header={
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    Your prices: <TierBadge tier={m.tier} />
                    {m.alcoholHidden ? <span>Alcoholic drinks are not shown{m.member && bar.data?.member.onBehalf ? ` for ${m.member.name}` : ""}.</span> : null}
                  </div>
                }
                emptyText="Nothing on the menu right now — please ask at the bar."
                renderAction={(item) => (
                  <Button size="sm" variant="outline" disabled={!memberId} onClick={() => cart.add(item)} aria-label={`Add ${item.name}`} data-testid="menu-add">
                    <Plus className="h-4 w-4" /> Add
                  </Button>
                )}
              />
            )}
          </DataState>
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {memberId && menu.data && ordering ? (
            <Cart memberId={memberId} menu={menu.data} ordering={ordering} onPlaced={(msg) => { setNotice(msg); void bar.reload(); }} />
          ) : null}
          <DataState state={bar}>
            {(d) => (
              <>
                <MyTab d={d} reload={() => void bar.reload()} />
                <PastTabs past={d.past} />
              </>
            )}
          </DataState>
        </div>
      </div>
    </div>
  );
}
