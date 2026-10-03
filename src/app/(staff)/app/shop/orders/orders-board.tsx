"use client";
import { useState } from "react";
import { Truck, Store, Phone } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { cn } from "@/components/ui/cn";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { PaymentPanel } from "@/components/payment-panel";
import { refundSummary } from "@/components/tender-fields";
import { fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { STATUS_LABEL, type OrderView } from "../_components/types";
import { OrderTimeline } from "../_components/order-timeline";
import { WhatsAppButton } from "@/components/whatsapp-button";

const COLUMNS: string[] = ["PENDING_PAYMENT", "CONFIRMED", "READY_FOR_PICKUP", "PACKED", "OUT_FOR_DELIVERY"];

function OrderCard({ o, onChange }: { o: OrderView; onChange: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [refunded, setRefunded] = useState<{ refunded: number; refundPending: number } | null>(null);
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
        <Badge tone="neutral">{o.paymentOption === "ONLINE" ? "Paid online" : o.paymentOption === "PAY_ON_DELIVERY" ? "Pay on delivery" : "Pay at pickup"}</Badge>
      </div>
      <ul className="list-disc pl-4 text-xs">
        {o.lines.map((l) => <li key={l.id}>{l.qty} × {l.name}</li>)}
      </ul>
      {o.address ? <p className="rounded bg-muted p-1 text-xs">{o.address}</p> : null}
      {o.holdExpiresAt && !handedOver ? <p className="text-xs text-amber-700">Hold expires {fmtDateTime(o.holdExpiresAt)}</p> : null}
      {o.cancelReason ? <p className="text-xs text-destructive">Cancelled: {o.cancelReason}</p> : null}
      {refunded !== null ? <p className="text-xs text-green-700">Cancelled{refunded.refunded || refunded.refundPending ? ` — ${refundSummary(refunded.refunded, refunded.refundPending)}` : ""}.</p> : null}
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
        <WhatsAppButton target={{ template: "ORDER", orderId: o.id }} />
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
              const r = await api<{ refunded: number; refundPending: number }>(`/api/shop/orders/${o.id}/cancel`, { body: { reason } });
              setRefunded(r);
              onChange();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

type ListOrder = {
  id: string; code: string; status: string; fulfilment: OrderView["fulfilment"]; payment_option: OrderView["paymentOption"]; address: string | null;
  hold_expires_at: string | null; created_at: string; cancel_reason: string | null; track_token: string; bill_id: string; member_id: string | null;
  customer: string; phone: string | null; customer_kind: "member" | "guest"; total: number; due: number; bill_status: string;
  next_statuses: string[]; lines: OrderView["lines"]; events: OrderView["events"];
};

const toView = (r: ListOrder): OrderView => ({
  id: r.id, code: r.code, status: r.status, fulfilment: r.fulfilment, paymentOption: r.payment_option, address: r.address, holdExpiresAt: r.hold_expires_at,
  createdAt: r.created_at, customer: r.customer, phone: r.phone, memberId: r.member_id, trackToken: r.track_token, billId: r.bill_id, total: r.total,
  due: r.due, billStatus: r.bill_status, cancelReason: r.cancel_reason, lines: r.lines, events: r.events, nextStatuses: r.next_statuses,
});

function Board({ rows }: { rows: ListOrder[] }) {
  const reload = useListReload();
  const closed = rows.filter((o) => !COLUMNS.includes(o.status));
  return (
    <div className="grid gap-3 lg:grid-cols-3 2xl:grid-cols-5">
      {COLUMNS.map((c) => {
        const col = rows.filter((o) => o.status === c);
        return (
          <div key={c} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
            <p className="px-1 text-sm font-semibold">{STATUS_LABEL[c]} <span className="text-muted-foreground">({col.length})</span></p>
            {col.length === 0 ? <p className="px-1 text-xs text-muted-foreground">None</p> : null}
            {col.map((o) => <OrderCard key={o.id} o={toView(o)} onChange={reload} />)}
          </div>
        );
      })}
      {closed.length ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
          <p className="px-1 text-sm font-semibold">Done <span className="text-muted-foreground">({closed.length})</span></p>
          {closed.map((o) => <OrderCard key={o.id} o={toView(o)} onChange={reload} />)}
        </div>
      ) : null}
    </div>
  );
}

function RowCard({ o }: { o: ListOrder }) {
  const reload = useListReload();
  return <div onClick={(e) => e.stopPropagation()}><OrderCard o={toView(o)} onChange={reload} /></div>;
}

const PAYS: Record<string, string> = { ONLINE: "Paid online", PAY_AT_PICKUP: "Pay at pickup", PAY_ON_DELIVERY: "Pay on delivery" };

export function OrdersBoard() {
  const [layout, setLayout] = useState<"board" | "list">("board");
  return (
    <FilteredList<ListOrder>
      list="orders"
      searchPlaceholder="Order code, customer, mobile or item"
      pollMs={15_000}
      toolbar={
        <div className="inline-flex rounded-full bg-secondary p-1" role="group" aria-label="Layout">
          {(["board", "list"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setLayout(v)} aria-pressed={layout === v} className={cn("rounded-full px-3 py-1 text-sm font-semibold", layout === v ? "bg-primary text-primary-foreground" : "text-secondary-foreground")}>
              {v === "board" ? "Board" : "List"}
            </button>
          ))}
        </div>
      }
      view={layout === "board" ? (rows) => <Board rows={rows} /> : undefined}
      columns={[
        { key: "code", header: "Order", cell: (o) => (
          <span className="flex flex-col">
            <span className="font-mono text-sm font-semibold">{o.code}</span>
            <RelTime when={o.created_at} className="text-xs text-muted-foreground" />
          </span>
        ) },
        { key: "customer", header: "Customer", cell: (o) => (
          <span className="flex flex-col">
            <span className="font-semibold">{o.customer}</span>
            <span className="text-xs text-muted-foreground">{o.customer_kind === "member" ? "Member" : "Guest"}{o.phone ? ` · ${o.phone}` : ""}</span>
          </span>
        ) },
        { key: "items", header: "Items", cell: (o) => <span className="text-sm">{o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ")}</span> },
        { key: "fulfilment", header: "Fulfilment", cell: (o) => (
          <span className="flex flex-col gap-0.5 text-sm">
            <span>{o.fulfilment === "DELIVERY" ? "Delivery" : "Pickup"}</span>
            <span className="text-xs text-muted-foreground">{PAYS[o.payment_option] ?? o.payment_option}</span>
          </span>
        ) },
        { key: "total", header: "Total", className: "text-right", cell: (o) => (
          <span className="flex flex-col items-end">
            <Money paise={o.total} className="font-semibold" />
            {o.due > 0 && o.status !== "CANCELLED" ? <span className="text-xs font-semibold text-amber-700">{formatINR(o.due)} due</span> : null}
          </span>
        ) },
        { key: "status", header: "Status", cell: (o) => <StatusBadge status={o.status} label={STATUS_LABEL[o.status]} /> },
        { key: "next", header: "Next", cell: (o) => (
          o.next_statuses.length ? <span className="text-sm font-semibold text-primary">Mark {STATUS_LABEL[o.next_statuses[0]]?.toLowerCase()} ↓</span>
          : o.due > 0 && o.status !== "CANCELLED" ? <span className="text-sm font-semibold text-primary">Take payment ↓</span> : null
        ) },
      ]}
      rowExtra={(o) => <RowCard o={o} />}
      empty={{ title: "No orders match these filters", hint: "New website and portal orders appear here automatically." }}
    />
  );
}
