"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { fmtDateTime } from "@/lib/time";
import { parseRupees } from "@/lib/money";

type Po = { id: string; code: string; supplier: string; status: string; note: string | null; total: number; createdAt: string; receivedAt: string | null; lines: Array<{ id: string; name: string; sku: string; qty: number; unitCost: number }> };
type StockRow = { variantId: string; sku: string; product: string; label: string; trackStock: boolean };
type Draft = { variantId: string; qty: string; unitCost: string };

const errOf = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function NewPo({ onDone }: { onDone: () => void }) {
  const stock = useApi<StockRow[]>("/api/shop/stock");
  const [supplier, setSupplier] = useState("");
  const [lines, setLines] = useState<Draft[]>([{ variantId: "", qty: "", unitCost: "" }]);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const items = (stock.data ?? []).filter((r) => r.trackStock);
  return (
    <Card>
      <CardHeader><CardTitle>New purchase order</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select className="col-span-12 sm:col-span-6" value={l.variantId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))} aria-label="Item">
              <option value="">Choose an item…</option>
              {items.map((r) => <option key={r.variantId} value={r.variantId}>{r.product}{r.label !== "Standard" ? ` · ${r.label}` : ""} ({r.sku})</option>)}
            </Select>
            <Input className="col-span-4 sm:col-span-2" inputMode="numeric" placeholder="Qty" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity" />
            <Input className="col-span-6 sm:col-span-3" inputMode="decimal" placeholder="Unit cost ₹" value={l.unitCost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} aria-label="Unit cost" />
            <Button className="col-span-2 sm:col-span-1" variant="ghost" size="icon" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="self-start" onClick={() => setLines([...lines, { variantId: "", qty: "", unitCost: "" }])}><Plus className="h-4 w-4" /> Add line</Button>
        <RejectionBanner error={error} />
        <Button
          className="self-start"
          onClick={async () => {
            setError(null);
            try {
              const body = {
                supplier,
                lines: lines.map((l) => {
                  const unitCost = parseRupees(l.unitCost);
                  if (!l.variantId || !/^\d+$/.test(l.qty) || unitCost === null) throw new ApiError("VALIDATION_FAILED", "Fill item, quantity and unit cost on every line.", 422, null);
                  return { variantId: l.variantId, qty: Number(l.qty), unitCost };
                }),
              };
              await api("/api/shop/purchase-orders", { body });
              setSupplier("");
              setLines([{ variantId: "", qty: "", unitCost: "" }]);
              onDone();
            } catch (e) {
              setError(errOf(e));
            }
          }}
        >
          Save draft
        </Button>
      </CardContent>
    </Card>
  );
}

function Actions({ po, onDone }: { po: Po; onDone: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const act = async (action: "order" | "receive" | "cancel", reason?: string) => {
    setError(null);
    try {
      await api(`/api/shop/purchase-orders/${po.id}`, { body: { action, reason } });
      onDone();
    } catch (e) {
      setError(errOf(e));
    }
  };
  if (po.status === "RECEIVED" || po.status === "CANCELLED") return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {po.status === "DRAFT" ? <Button size="sm" variant="outline" onClick={() => act("order")}>Mark ordered</Button> : null}
        <Button size="sm" onClick={() => act("receive")}>Goods received</Button>
        <ConfirmButton trigger="Cancel" title={`Cancel ${po.code}?`} description="Cancelled orders are kept, never deleted." requireReason confirmLabel="Cancel order" onConfirm={(reason) => act("cancel", reason)} />
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function PurchaseOrders({ canManage }: { canManage: boolean }) {
  const state = useApi<Po[]>("/api/shop/purchase-orders");
  return (
    <div className="flex flex-col gap-4">
      {canManage ? <NewPo onDone={() => void state.reload()} /> : null}
      <DataState state={state}>
        {(pos) =>
          pos.length === 0 ? (
            <Empty title="No purchase orders yet" />
          ) : (
            <div className="flex flex-col gap-3">
              {pos.map((po) => (
                <Card key={po.id}>
                  <CardContent className="flex flex-col gap-2 pt-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span><span className="font-mono">{po.code}</span> · {po.supplier} · {fmtDateTime(po.createdAt)}</span>
                      <span className="flex items-center gap-2"><Money paise={po.total} className="font-semibold" /><Badge tone={po.status === "RECEIVED" ? "green" : po.status === "CANCELLED" ? "neutral" : "amber"}>{po.status.toLowerCase()}</Badge></span>
                    </div>
                    <ul className="text-xs text-muted-foreground">
                      {po.lines.map((l) => <li key={l.id}>{l.qty} × {l.name} ({l.sku}) @ <Money paise={l.unitCost} /></li>)}
                    </ul>
                    {po.note ? <p className="text-xs">{po.note}</p> : null}
                    {canManage ? <Actions po={po} onDone={() => void state.reload()} /> : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        }
      </DataState>
    </div>
  );
}
