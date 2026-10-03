"use client";
import { useState } from "react";
import { History, PackagePlus, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { categoryLabel, SHOP_CATEGORIES } from "@/components/shop-quote";
import { fmtDateTime } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";

type Row = {
  variantId: string; sku: string; product: string; productId: string; label: string; category: string; price: number;
  onHand: number; reserved: number; available: number; reorderLevel: number; trackStock: boolean; low: boolean;
};
type Movement = { id: string; qtyOnHandDelta: number; qtyReservedDelta: number; reason: string; refType: string | null; refId: string | null; unitCost: number | null; note: string | null; createdAt: string };
type Err = { code?: string; message: string } | null;

const errOf = (e: unknown): Err => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function ReceiveDialog({ row, onDone }: { row: Row; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ qty: "", unitCost: "", supplier: "", createPayable: false, inputGst: "", dueInDays: "30" });
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><PackagePlus className="h-4 w-4" /> Receive</Button></DialogTrigger>
      <DialogContent title={`Receive goods: ${row.product} (${row.label})`} description="Adds to on-hand stock as a RECEIPT movement (SH-9). Optionally records the supplier bill as a payable.">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Quantity"><Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} autoFocus /></Field>
            <Field label="Unit cost ₹"><Input inputMode="decimal" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} /></Field>
          </div>
          <Field label="Supplier"><Input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.createPayable} onChange={(e) => setF({ ...f, createPayable: e.target.checked })} /> Create a supplier bill (payable)
          </label>
          {f.createPayable ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Input GST ₹"><Input inputMode="decimal" value={f.inputGst} onChange={(e) => setF({ ...f, inputGst: e.target.value })} /></Field>
              <Field label="Due in days"><Input inputMode="numeric" value={f.dueInDays} onChange={(e) => setF({ ...f, dueInDays: e.target.value })} /></Field>
            </div>
          ) : null}
          <RejectionBanner error={error} />
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try {
              const unitCost = parseRupees(f.unitCost || "0");
              if (unitCost === null) throw new ApiError("VALIDATION_FAILED", "Enter the unit cost in rupees.", 422, null);
              await api("/api/shop/stock/receive", { body: {
                variantId: row.variantId, qty: Number(f.qty), unitCost, supplier: f.supplier, createPayable: f.createPayable,
                inputGst: f.createPayable && f.inputGst ? (parseRupees(f.inputGst) ?? 0) : 0, dueInDays: Number(f.dueInDays || 30),
              } });
              setOpen(false); setF({ qty: "", unitCost: "", supplier: "", createPayable: false, inputGst: "", dueInDays: "30" }); onDone();
            } catch (e) { setError(errOf(e)); } finally { setBusy(false); }
          }}>Record receipt</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ row, onDone }: { row: Row; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><SlidersHorizontal className="h-4 w-4" /> Adjust</Button></DialogTrigger>
      <DialogContent title={`Adjust stock: ${row.product} (${row.label})`} description={`On hand ${row.onHand}, reserved ${row.reserved}. Use + to add, − to remove (damage, loss, recount).`}>
        <div className="flex flex-col gap-3">
          <Field label="Change (e.g. -1 or 2)"><Input inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <RejectionBanner error={error} />
          <Button disabled={busy || !delta || reason.trim().length < 3} onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api("/api/shop/stock/adjust", { body: { variantId: row.variantId, delta: Number(delta), reason } });
              setOpen(false); setDelta(""); setReason(""); onDone();
            } catch (e) { setError(errOf(e)); } finally { setBusy(false); }
          }}>Save adjustment</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditVariantDialog({ row, onDone, canPrice }: { row: Row; onDone: () => void; canPrice: boolean }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState((row.price / 100).toFixed(2));
  const [reorder, setReorder] = useState(String(row.reorderLevel));
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label="Edit"><Pencil className="h-4 w-4" /></Button></DialogTrigger>
      <DialogContent title={`Edit ${row.product} (${row.label})`} description={canPrice ? "Price changes apply to new sales only; existing bills keep their snapshot prices." : "Only the owner or manager can change prices."}>
        <div className="flex flex-col gap-3">
          <Field label="Price ₹ (GST inclusive)"><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="Reorder level"><Input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} /></Field>
          <RejectionBanner error={error} />
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try {
              const p = parseRupees(price);
              const body: Record<string, number> = { reorderLevel: Number(reorder) };
              if (p !== null && p !== row.price) body.price = p;
              await api(`/api/shop/variants/${row.variantId}`, { method: "PATCH", body });
              setOpen(false); onDone();
            } catch (e) { setError(errOf(e)); } finally { setBusy(false); }
          }}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MovementsDialog({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const state = useApi<Movement[]>(open ? `/api/shop/stock/${row.variantId}/movements` : null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label="Movements"><History className="h-4 w-4" /></Button></DialogTrigger>
      <DialogContent title={`Stock movements: ${row.product} (${row.label})`} description={`SKU ${row.sku} · on hand ${row.onHand} · reserved ${row.reserved}`} wide>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No movements yet" }}>
          {(rows) => (
            <Table>
              <THead><TR><TH>When</TH><TH>Reason</TH><TH className="text-right">On hand</TH><TH className="text-right">Reserved</TH><TH>Reference</TH></TR></THead>
              <TBody>
                {rows.map((m) => (
                  <TR key={m.id}>
                    <TD className="text-xs">{fmtDateTime(m.createdAt)}</TD>
                    <TD><Badge tone={m.reason === "RECEIPT" || m.reason === "RETURN" ? "green" : m.reason === "RESERVE" ? "amber" : "neutral"}>{m.reason.replace("_", " ")}</Badge></TD>
                    <TD className="text-right tabular">{m.qtyOnHandDelta ? signed(m.qtyOnHandDelta) : "—"}</TD>
                    <TD className="text-right tabular">{m.qtyReservedDelta ? signed(m.qtyReservedDelta) : "—"}</TD>
                    <TD className="text-xs">{m.refType ?? ""} {m.note ?? ""}{m.unitCost ? ` @ ${formatINR(m.unitCost)}` : ""}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}

type VRow = { sku: string; label: string; price: string; reorderLevel: string; hsnSac: string };

function NewProductDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", brand: "", category: "ACCESSORIES", description: "", isRestring: false });
  const [variants, setVariants] = useState<VRow[]>([{ sku: "", label: "Standard", price: "", reorderLevel: "3", hsnSac: "9506" }]);
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New product</Button></DialogTrigger>
      <DialogContent title="New product" description="Stock starts at zero — record a receipt to put units on the shelf." wide>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Brand"><Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></Field>
            <Field label="Category">
              <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {SHOP_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
              </Select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={f.isRestring} onChange={(e) => setF({ ...f, isRestring: e.target.checked })} /> Restringing service (creates tickets)
            </label>
          </div>
          <Field label="Description"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <p className="text-sm font-medium">Variants</p>
          {variants.map((v, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Input className="col-span-3" placeholder="SKU" value={v.sku} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} />
              <Input className="col-span-3" placeholder="Label (size/colour)" value={v.label} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Input className="col-span-2" placeholder="Price ₹" inputMode="decimal" value={v.price} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              <Input className="col-span-1" placeholder="Reorder" inputMode="numeric" value={v.reorderLevel} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, reorderLevel: e.target.value } : x)))} />
              <Input className="col-span-2" placeholder="HSN/SAC" value={v.hsnSac} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, hsnSac: e.target.value } : x)))} />
              <Button className="col-span-1" size="icon" variant="ghost" aria-label="Remove variant" disabled={variants.length === 1} onClick={() => setVariants(variants.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setVariants([...variants, { sku: "", label: "", price: "", reorderLevel: "3", hsnSac: variants[0].hsnSac }])}><Plus className="h-4 w-4" /> Add variant</Button>
          <RejectionBanner error={error} />
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api("/api/shop/products", { body: {
                ...f,
                variants: variants.map((v) => {
                  const price = parseRupees(v.price);
                  if (price === null) throw new ApiError("VALIDATION_FAILED", `Enter a price for variant ${v.sku || v.label}.`, 422, null);
                  return { sku: v.sku, label: v.label || "Standard", price, reorderLevel: Number(v.reorderLevel || 0), hsnSac: v.hsnSac };
                }),
              } });
              setOpen(false); onDone();
            } catch (e) { setError(errOf(e)); } finally { setBusy(false); }
          }}>Create product</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function StockTable({ lowOnly: initialLow, perms }: { lowOnly: boolean; perms: { stock: boolean; price: boolean } }) {
  const [low, setLow] = useState(initialLow);
  const [q, setQ] = useState("");
  const state = useApi<Row[]>(`/api/shop/stock?low=${low ? "1" : ""}&q=${encodeURIComponent(q.trim())}`);
  const reload = () => void state.reload();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search product" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant={!low ? "default" : "outline"} onClick={() => setLow(false)}>All stock</Button>
        <Button size="sm" variant={low ? "default" : "outline"} onClick={() => setLow(true)}>Low stock only</Button>
        {perms.stock ? <div className="ml-auto"><NewProductDialog onDone={reload} /></div> : null}
      </div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: low ? "Nothing is low on stock" : "No products found" }}>
          {(rows) => (
            <Table>
              <THead>
                <TR><TH>Product</TH><TH>SKU</TH><TH>Category</TH><TH className="text-right">Price</TH><TH className="text-right">On hand</TH><TH className="text-right">Reserved</TH><TH className="text-right">Available</TH><TH className="text-right">Reorder</TH><TH /></TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.variantId} className={r.low ? "bg-red-50/60" : undefined}>
                    <TD><span className="font-medium">{r.product}</span>{r.label !== "Standard" ? <span className="text-muted-foreground"> · {r.label}</span> : null} {r.low ? <Badge tone="red">LOW</Badge> : null}</TD>
                    <TD className="font-mono text-xs">{r.sku}</TD>
                    <TD className="text-sm">{categoryLabel(r.category)}</TD>
                    <TD className="text-right"><Money paise={r.price} /></TD>
                    {r.trackStock ? (
                      <>
                        <TD className="text-right tabular">{r.onHand}</TD>
                        <TD className="text-right tabular">{r.reserved}</TD>
                        <TD className="text-right font-semibold tabular">{r.available}</TD>
                        <TD className="text-right tabular">{r.reorderLevel}</TD>
                      </>
                    ) : (
                      <TD colSpan={4} className="text-center text-xs text-muted-foreground">Service — no stock</TD>
                    )}
                    <TD>
                      <div className="flex justify-end gap-1">
                        {perms.stock && r.trackStock ? <ReceiveDialog row={r} onDone={reload} /> : null}
                        {perms.stock && r.trackStock ? <AdjustDialog row={r} onDone={reload} /> : null}
                        {r.trackStock ? <MovementsDialog row={r} /> : null}
                        {perms.stock ? <EditVariantDialog row={r} onDone={reload} canPrice={perms.price} /> : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
    </div>
  );
}
