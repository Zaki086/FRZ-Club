"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Truck, Store } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";

type Order = {
  code: string; status: string; fulfilment: "PICKUP" | "DELIVERY"; paymentOption: string; address: string | null; holdExpiresAt: string | null;
  createdAt: string; billId: string; total: number; due: number; cancelReason: string | null;
  lines: Array<{ id: string; name: string; qty: number; netAmount: number }>;
  events: Array<{ status: string; at: string; note: string | null }>;
};
type Me = { kind: string; role?: string };

const LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment", CONFIRMED: "Confirmed", READY_FOR_PICKUP: "Ready for pickup", COLLECTED: "Collected",
  PACKED: "Packed", OUT_FOR_DELIVERY: "Out for delivery", DELIVERED: "Delivered", CANCELLED: "Cancelled",
};
const STEPS = { PICKUP: ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP", "COLLECTED"], DELIVERY: ["PENDING_PAYMENT", "CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "DELIVERED"] };

export function OrderTracking({ token }: { token: string }) {
  const params = useSearchParams();
  const state = useApi<Order>(`/api/orders/track/${token}`, { pollMs: 30000 });
  const me = useApi<Me>("/api/auth/me");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const payment = params.get("payment");
  return (
    <DataState state={state}>
      {(o) => {
        const steps = STEPS[o.fulfilment];
        const reached = new Set(o.events.map((e) => e.status));
        const isMember = me.data?.kind === "USER" && me.data.role === "MEMBER";
        return (
          <div className="flex flex-col gap-4">
            {payment === "success" ? <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">Payment received — thank you! Your order is confirmed.</div> : null}
            {payment === "failed" ? <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">The payment did not go through. Your items are held for a short while.</div> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm text-muted-foreground">Order</p>
                <h1 className="font-mono text-2xl font-bold">{o.code}</h1>
              </div>
              <StatusBadge status={o.status} label={LABEL[o.status]} />
            </div>
            {o.status !== "CANCELLED" ? (
              <ol className="flex flex-wrap gap-2">
                {steps.map((s) => (
                  <li key={s} className={cn("rounded-full px-3 py-1 text-xs font-medium", reached.has(s) || o.status === s ? "bg-primary text-white" : "bg-muted text-muted-foreground")}>{LABEL[s]}</li>
                ))}
              </ol>
            ) : (
              <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">This order was cancelled{o.cancelReason ? `: ${o.cancelReason}` : ""}.</p>
            )}
            <Card>
              <CardContent className="flex flex-col gap-2 pt-4 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  {o.fulfilment === "DELIVERY" ? <Truck className="h-4 w-4" /> : <Store className="h-4 w-4" />}
                  {o.fulfilment === "DELIVERY" ? `Delivery to ${o.address}` : "Collect at the club shop counter"}
                </p>
                <div className="divide-y rounded-md border">
                  {o.lines.map((l) => (
                    <div key={l.id} className="flex justify-between p-2"><span>{l.qty} × {l.name}</span><Money paise={l.netAmount} /></div>
                  ))}
                </div>
                <p className="flex justify-between font-semibold"><span>Total</span><Money paise={o.total} /></p>
                {o.due > 0 && o.status !== "CANCELLED" ? <p className="flex justify-between text-amber-700"><span>To pay</span><span>{formatINR(o.due)}</span></p> : null}
                {o.holdExpiresAt && o.status === "PENDING_PAYMENT" ? <p className="text-xs text-muted-foreground">Held until {fmtDateTime(o.holdExpiresAt)}.</p> : null}
              </CardContent>
            </Card>
            {o.status === "PENDING_PAYMENT" && o.due > 0 ? (
              isMember ? (
                <div className="flex flex-col gap-2">
                  <RejectionBanner error={error} />
                  <Button size="lg" onClick={async () => {
                    setError(null);
                    try {
                      const r = await api<{ redirectUrl: string }>("/api/payments/online/start", { body: { billId: o.billId, returnUrl: `/orders/${token}` }, idempotencyKey: newIdempotencyKey() });
                      window.location.href = r.redirectUrl;
                    } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
                  }}>Pay now</Button>
                </div>
              ) : (
                <p className="rounded-md border bg-muted/50 p-3 text-sm">Payment was not completed. Please contact the club front desk to pay, or place the order again — unpaid orders are released automatically.</p>
              )
            ) : null}
            <div>
              <p className="mb-1 text-sm font-semibold">History</p>
              <ol className="flex flex-col gap-1 border-l-2 border-primary/30 pl-3 text-xs">
                {o.events.map((e, i) => (
                  <li key={i}><span className="font-semibold">{LABEL[e.status] ?? e.status}</span> · {fmtDateTime(e.at)}{e.note ? ` — ${e.note}` : ""}</li>
                ))}
              </ol>
            </div>
          </div>
        );
      }}
    </DataState>
  );
}
