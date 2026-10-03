"use client";
import { useState } from "react";
import { Truck, Store, Phone } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { PaymentPanel } from "@/components/payment-panel";
import { fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { STATUS_LABEL, type OrderView } from "../_components/types";
import { OrderTimeline } from "../_components/order-timeline";

const COLUMNS = ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP", "PACKED", "OUT_FOR_DELIVERY"];

function OrderCard({ o, onChange }: { o: OrderView; onChange: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [refunded, setRefunded] = useState<number | null>(null);
  const handedOver = ["COLLECTED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"].includes(o.status);
  return (
    <Card className="flex flex-col gap-2 p-3 text-sm" data-testid={`order-${o.code}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs font-semibold">{o.code}</p>
          <p className="font-semibold">{o.customer}</p>
          {o.phone ? <a className="inline-flex items-center gap-1 text-xs text-primary" href={`tel:${o.phone}`}><Phone className="h-3 w-3" />{o.phone}</a> : null}
        </div>
        <div className="text-right">
          <Money paise={o.total} className="font-semibold" />
          {o.due > 0 ? <p className="text-xs font-semibold text-amber-700">{formatINR(o.due)} due</p> : <p className="text-xs text-green-700">Paid</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status={o.status} label={STATUS_LABEL[o.status]} />
        <Badge tone={o.fulfilment === "DELIVERY" ? "blue" : "neutral"}>
          {o.fulfilment === "DELIVERY" ? <Truck className="mr-1 h-3 w-3" /> : <Store className="mr-1 h-3 w-3" />}
          {o.fulfilment === "DELIVERY" ? "Delivery" : "Pickup"}
        </Badge>
        <Badge tone="neutral">{o.paymentOption === "ONLINE" ? "Paid online" : "Pay at pickup"}</Badge>
      </div>
      <ul className="list-disc pl-4 text-xs">
        {o.lines.map((l) => <li key={l.id}>{l.qty} × {l.name}</li>)}
      </ul>
      {o.address ? <p className="rounded bg-muted p-1 text-xs">{o.address}</p> : null}
      {o.holdExpiresAt && !handedOver ? <p className="text-xs text-amber-700">Hold expires {fmtDateTime(o.holdExpiresAt)}</p> : null}
      {o.cancelReason ? <p className="text-xs text-destructive">Cancelled: {o.cancelReason}</p> : null}
      {refunded !== null ? <p className="text-xs text-green-700">Cancelled — {formatINR(refunded)} refunded.</p> : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Timeline</summary>
        <OrderTimeline events={o.events} />
      </details>
      <RejectionBanner error={error} />
      <div className="flex flex-wrap gap-1">
        {o.nextStatuses.map((s) => (
          <Button
            key={s}
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/api/shop/orders/${o.id}/status`, { body: { status: s } });
                onChange();
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Mark {STATUS_LABEL[s]?.toLowerCase() ?? s}
          </Button>
        ))}
        {o.due > 0 && o.status !== "CANCELLED" ? (
          <Dialog open={payOpen} onOpenChange={(v) => { setPayOpen(v); if (!v) onChange(); }}>
            <DialogTrigger asChild><Button size="sm" variant="outline">Take payment</Button></DialogTrigger>
            <DialogContent title={`Payment for ${o.code}`} wide>
              <PaymentPanel billId={o.billId} onPaid={onChange} />
            </DialogContent>
          </Dialog>
        ) : null}
        {!handedOver ? (
          <ConfirmButton
            trigger="Cancel"
            title={`Cancel order ${o.code}`}
            description="Releases the reserved stock and refunds anything paid."
            requireReason
            confirmLabel="Cancel order"
            onConfirm={async (reason) => {
              const r = await api<{ refunded: number }>(`/api/shop/orders/${o.id}/cancel`, { body: { reason } });
              setRefunded(r.refunded);
              onChange();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

export function OrdersBoard() {
  const [all, setAll] = useState(false);
  const state = useApi<OrderView[]>(all ? "/api/shop/orders" : "/api/shop/orders?status=OPEN", { pollMs: 15000 });
  const reload = () => void state.reload();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button size="sm" variant={!all ? "default" : "outline"} onClick={() => setAll(false)}>Open orders</Button>
        <Button size="sm" variant={all ? "default" : "outline"} onClick={() => setAll(true)}>All orders</Button>
      </div>
      <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: all ? "No online orders yet" : "No open orders", hint: "New website and portal orders appear here automatically." }}>
        {(orders) =>
          all ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {orders.map((o) => <OrderCard key={o.id} o={o} onChange={reload} />)}
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-3 2xl:grid-cols-5">
              {COLUMNS.map((c) => {
                const col = orders.filter((o) => o.status === c);
                return (
                  <div key={c} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
                    <p className="px-1 text-sm font-semibold">{STATUS_LABEL[c]} <span className="text-muted-foreground">({col.length})</span></p>
                    {col.length === 0 ? <p className="px-1 text-xs text-muted-foreground">None</p> : null}
                    {col.map((o) => <OrderCard key={o.id} o={o} onChange={reload} />)}
                  </div>
                );
              })}
            </div>
          )
        }
      </DataState>
    </div>
  );
}
