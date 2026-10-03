"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
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

type ListPo = {
  id: string; code: string; supplier: string; status: string; note: string | null; created_at: string; ordered_at: string | null; received_at: string | null;
  created_by_name: string | null; total: number; units: number; lines: Po["lines"];
};

const STATUS_TONE: Record<string, "green" | "neutral" | "amber" | "blue"> = { RECEIVED: "green", CANCELLED: "neutral", ORDERED: "blue", DRAFT: "amber" };

function RowActions({ po }: { po: ListPo }) {
  const reload = useListReload();
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Actions po={{ id: po.id, code: po.code, supplier: po.supplier, status: po.status, note: po.note, total: po.total, createdAt: po.created_at, receivedAt: po.received_at, lines: po.lines }} onDone={reload} />
    </div>
  );
}

export function PurchaseOrders({ canManage }: { canManage: boolean }) {
  // A new draft remounts the list so it shows straight away.
  const [version, setVersion] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      {canManage ? <NewPo onDone={() => setVersion((v) => v + 1)} /> : null}
      <FilteredList<ListPo>
        key={version}
        list="purchase-orders"
        searchPlaceholder="PO code, supplier, item or note"
        columns={[
          { key: "code", header: "Order", cell: (po) => (
            <span className="flex flex-col">
              <span className="font-mono text-sm font-semibold">{po.code}</span>
              <RelTime when={po.created_at} className="text-xs text-muted-foreground" />
            </span>
          ) },
          { key: "supplier", header: "Supplier", cell: (po) => <span className="font-semibold">{po.supplier}</span> },
          { key: "lines", header: "Items", cell: (po) => (
            <ul className="text-xs text-muted-foreground">
              {po.lines.map((l) => <li key={l.id}>{l.qty} × {l.name} ({l.sku}) @ <Money paise={l.unitCost} /></li>)}
            </ul>
          ) },
          { key: "total", header: "Total", className: "text-right", cell: (po) => <Money paise={po.total} className="font-semibold" /> },
          { key: "status", header: "Status", cell: (po) => <Badge tone={STATUS_TONE[po.status] ?? "neutral"}>{po.status.toLowerCase()}</Badge> },
          ...(canManage ? [{ key: "next", header: "Next", cell: (po: ListPo) => <RowActions po={po} /> }] : []),
        ]}
        rowExtra={(po) => (
          <div className="grid gap-1 text-sm sm:grid-cols-2">
            <span>{po.note ?? "No note"}</span>
            <span className="text-muted-foreground">
              Created {fmtDateTime(po.created_at)}{po.created_by_name ? ` by ${po.created_by_name}` : ""}
              {po.ordered_at ? ` · ordered ${fmtDateTime(po.ordered_at)}` : ""}
              {po.received_at ? ` · received ${fmtDateTime(po.received_at)}` : ""}
            </span>
          </div>
        )}
        empty={{ title: "No purchase orders match these filters", hint: canManage ? "Create a draft above." : undefined }}
      />
    </div>
  );
}
