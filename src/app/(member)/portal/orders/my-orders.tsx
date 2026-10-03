"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ShoppingBag } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { refundSummary } from "@/components/tender-fields";

type Order = {
  id: string; code: string; status: string; fulfilment: string; paymentOption: string; createdAt: string; billId: string;
  total: number; due: number; trackToken: string; cancelReason: string | null; holdExpiresAt: string | null;
  lines: Array<{ id: string; name: string; qty: number; netAmount: number }>;
  events: Array<{ status: string; at: string; note: string | null }>;
};
type Ticket = { id: string; code: string; racket: string; status: string; promisedAt: string };

const LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment", CONFIRMED: "Confirmed", READY_FOR_PICKUP: "Ready for pickup", COLLECTED: "Collected",
  PACKED: "Packed", OUT_FOR_DELIVERY: "Out for delivery", DELIVERED: "Delivered", CANCELLED: "Cancelled",
};
const FINAL = ["COLLECTED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];

function OrderCard({ o, onChange }: { o: Order; onChange: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [refunded, setRefunded] = useState<{ refunded: number; refundPending: number } | null>(null);
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono font-semibold">{o.code}</p>
            <p className="text-xs text-muted-foreground">{fmtDateTime(o.createdAt)} · {o.fulfilment === "DELIVERY" ? "Delivery" : "Pickup"} · {o.paymentOption === "ONLINE" ? "Online payment" : o.paymentOption === "PAY_ON_DELIVERY" ? "Pay on delivery" : "Pay at pickup"}</p>
          </div>
          <StatusBadge status={o.status} label={LABEL[o.status]} />
        </div>
        <ul className="list-disc pl-5">
          {o.lines.map((l) => <li key={l.id}>{l.qty} × {l.name} — {formatINR(l.netAmount)}</li>)}
        </ul>
        <p className="flex justify-between font-semibold"><span>Total</span><Money paise={o.total} /></p>
        {o.due > 0 && o.status !== "CANCELLED" ? <p className="text-warning-text">To pay: {formatINR(o.due)}</p> : null}
        {o.cancelReason ? <p className="text-destructive">Cancelled: {o.cancelReason}</p> : null}
        {refunded !== null ? <p className="text-success-text">Cancelled{refunded.refunded || refunded.refundPending ? ` — ${refundSummary(refunded.refunded, refunded.refundPending)}` : ""}.</p> : null}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Tracking</summary>
          <ol className="mt-1 flex flex-col gap-1 border-l-2 border-primary/30 pl-3 text-xs">
            {o.events.map((e, i) => <li key={i}><span className="font-semibold">{LABEL[e.status] ?? e.status}</span> · {fmtDateTime(e.at)}{e.note ? ` — ${e.note}` : ""}</li>)}
          </ol>
        </details>
        <RejectionBanner error={error} />
        <div className="flex flex-wrap gap-2">
          {o.due > 0 && o.status !== "CANCELLED" ? (
            <Button size="sm" onClick={async () => {
              setError(null);
              try {
                const r = await api<{ redirectUrl: string }>("/api/payments/online/start", { body: { billId: o.billId, returnUrl: "/portal/orders" }, idempotencyKey: newIdempotencyKey() });
                window.location.href = r.redirectUrl;
              } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
            }}>Pay online</Button>
          ) : null}
          {!FINAL.includes(o.status) ? (
            <ConfirmButton
              trigger="Cancel order"
              title={`Cancel ${o.code}?`}
              description="Your items go back on the shelf and anything you paid is refunded."
              requireReason
              confirmLabel="Cancel order"
              onConfirm={async (reason) => {
                const r = await api<{ refunded: number; refundPending: number }>(`/api/shop/orders/${o.id}/cancel`, { body: { reason } });
                setRefunded(r);
                onChange();
              }}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function MyOrders() {
  const params = useSearchParams();
  const orders = useApi<Order[]>("/api/shop/orders");
  const tickets = useApi<Ticket[]>("/api/shop/tickets");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Shop orders</h1>
        <Button asChild size="sm"><Link href="/shop"><ShoppingBag className="h-4 w-4" /> Shop</Link></Button>
      </div>
      {params.get("payment") === "success" ? <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">Payment received — thank you!</div> : null}
      {params.get("payment") === "failed" ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">The payment did not go through. You can try again.</div> : null}
      <DataState state={orders} isEmpty={(d) => d.length === 0} empty={{ title: "No orders yet", hint: "Order gear online and collect it at the club or get it delivered." }}>
        {(rows) => <div className="flex flex-col gap-3">{rows.map((o) => <OrderCard key={o.id} o={o} onChange={() => void orders.reload()} />)}</div>}
      </DataState>
      <Card>
        <CardHeader><CardTitle>Racket restringing</CardTitle></CardHeader>
        <CardContent>
          <DataState state={tickets} isEmpty={(d) => d.length === 0} empty={{ title: "No restring tickets", hint: "Hand in your racket at the shop counter." }}>
            {(rows) => (
              <div className="divide-y">
                {rows.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div>
                      <p className="font-medium">{t.racket} <span className="font-mono text-xs text-muted-foreground">{t.code}</span></p>
                      <p className="text-xs text-muted-foreground">Promised {fmtDateTime(t.promisedAt)}</p>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
