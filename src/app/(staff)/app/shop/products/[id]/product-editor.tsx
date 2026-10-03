"use client";
// v3 §9.3: one product — details, up to 5 photos (first = cover; drag or use the arrows to reorder), sizes/colours with
// SKU, HSN and prices (through the price book, now or scheduled — D-79: shop staff too), the restring flag, inline
// discounts (shop staff up to their limit) and archive/restore. Stock is shown, never edited here.
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { PageHeader } from "@/components/page";
import { DataState, RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { formatINR, parseRupees } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { DiscountForm, DiscountList, type DiscountView } from "../_components/discounts";

type Detail = {
  id: string; name: string; brand: string; category: string; description: string; isRestring: boolean; trackStock: boolean; archivedAt: string | null;
  canEdit: boolean; canEditPrices: boolean; staffLimitPct: number;
  images: Array<{ id: string; url: string; thumbUrl: string; sort: number }>;
  variants: Array<{ id: string; sku: string; label: string; price: number; onHand: number; reserved: number; available: number; reorderLevel: number; taxCategory: string; hsnSac: string; archivedAt: string | null; scheduled: Array<{ id: string; price: number; effectiveAt: string }> }>;
  promotions: DiscountView[];
};
const CATEGORIES = ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"];
const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const toErr = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function Details({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [f, setF] = useState({ name: d.name, brand: d.brand, category: d.category, description: d.description, isRestring: d.isRestring });
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); setError(null); setSaved(false); try { await api(`/api/shop/products/${d.id}`, { method: "PATCH", body: f }); setSaved(true); onDone(); } catch (err) { setError(toErr(err)); } }}>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!d.canEdit} required /></Field>
        <Field label="Brand"><Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} disabled={!d.canEdit} /></Field>
        <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} disabled={!d.canEdit}>{CATEGORIES.map((c) => <option key={c} value={c}>{nice(c)}</option>)}</Select></Field>
      </div>
      <Field label={`Description (${f.description.length}/2000)`}><Textarea rows={5} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!d.canEdit} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isRestring} onChange={(e) => setF({ ...f, isRestring: e.target.checked })} disabled={!d.canEdit} /> Restringing service (opens a restring ticket when sold)</label>
      <RejectionBanner error={error} />
      {saved ? <p className="text-sm text-success-text">Saved — the public shop shows it now.</p> : null}
      {d.canEdit ? <Button type="submit" className="self-start">Save details</Button> : null}
    </form>
  );
}

function Photos({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const order = async (ids: string[]) => {
    setError(null);
    try { await api(`/api/shop/products/${d.id}/photos/order`, { method: "PUT", body: { ids } }); onDone(); } catch (e) { setError(toErr(e)); }
  };
  const move = (i: number, by: number) => { const ids = d.images.map((x) => x.id); const j = i + by; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; void order(ids); };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3" data-testid="product-photos">
        {d.images.map((img, i) => (
          <figure
            key={img.id}
            className="flex w-32 flex-col gap-1"
            draggable={d.canEdit}
            onDragStart={() => setDrag(img.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (!drag || drag === img.id) return; const ids = d.images.map((x) => x.id).filter((x) => x !== drag); ids.splice(i, 0, drag); setDrag(null); void order(ids); }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- the club's own uploaded photo */}
            <img src={img.thumbUrl} alt={`${d.name} photo ${i + 1}`} width={128} height={128} className="h-32 w-32 rounded-xl border object-cover" />
            <figcaption className="flex items-center justify-between text-xs">
              {i === 0 ? <Badge tone="green">Cover</Badge> : <span>{i + 1}</span>}
              {d.canEdit ? (
                <span className="flex">
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Move left" disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Move right" disabled={i === d.images.length - 1} onClick={() => move(i, 1)}><ArrowRight className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove photo ${i + 1}`} onClick={async () => { await api(`/api/shop/products/${d.id}/photos/${img.id}`, { method: "DELETE" }); onDone(); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                </span>
              ) : null}
            </figcaption>
          </figure>
        ))}
        {!d.images.length ? <p className="text-sm text-muted-foreground">No photos yet — the shop shows the category icon.</p> : null}
      </div>
      {d.canEdit && d.images.length < 5 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Add photos (PNG, JPEG or WebP, up to 2 MB each; {5 - d.images.length} more allowed)</span>
          <input
            type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} aria-label="Add photos"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])].slice(0, 5 - d.images.length);
              e.target.value = "";
              setBusy(true);
              setError(null);
              try {
                for (const file of files) {
                  const fd = new FormData();
                  fd.set("file", file);
                  const res = await fetch(`/api/shop/products/${d.id}/photos`, { method: "POST", body: fd });
                  const j = await res.json();
                  if (!res.ok) throw new ApiError(j.error?.code ?? "HTTP", j.error?.message ?? "Upload failed", res.status, null);
                }
              } catch (err) {
                setError(toErr(err));
              } finally {
                setBusy(false);
                onDone();
              }
            }}
          />
          {busy ? <span className="text-xs text-muted-foreground">Uploading and resizing…</span> : null}
        </label>
      ) : null}
      <RejectionBanner error={error} />
    </div>
  );
}

function VariantRow({ d, v, onDone }: { d: Detail; v: Detail["variants"][number]; onDone: () => void }) {
  const [price, setPrice] = useState((v.price / 100).toFixed(2));
  const [when, setWhen] = useState("");
  const [reorder, setReorder] = useState(String(v.reorderLevel));
  const [label, setLabel] = useState(v.label);
  const [sku, setSku] = useState(v.sku);
  const [hsn, setHsn] = useState(v.hsnSac);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const paise = parseRupees(price);
      if (d.canEditPrices && price.trim() && paise === null) return setError({ message: "Enter the price in rupees, e.g. 1499 or 1499.50." });
      // A price is a new price-book version (history + audit), now or from the chosen date and time.
      if (d.canEditPrices && paise !== null && (paise !== v.price || when)) {
        await api("/api/pricing/prices", { body: { target: `VARIANT:${v.id}`, price: paise, effectiveAt: when ? new Date(`${when}:00+05:30`).toISOString() : undefined } });
      }
      await api(`/api/shop/variants/${v.id}`, { method: "PATCH", body: { label, sku, hsnSac: hsn, reorderLevel: Number(reorder) } });
      // A scheduled price isn't today's price: the field goes back to the current one (so a later Save can't apply it early).
      if (when) setPrice((v.price / 100).toFixed(2));
      setWhen("");
      setSaved(true);
      onDone();
    } catch (e) {
      setError(toErr(e));
    }
  };
  return (
    <TR>
      <TD>
        <Input className="h-8" value={label} onChange={(e) => setLabel(e.target.value)} disabled={!d.canEdit} aria-label="Size / colour" />
        {d.canEdit ? <Input className="mt-1 h-7 font-mono text-xs" value={sku} onChange={(e) => setSku(e.target.value)} aria-label={`SKU for ${v.label}`} /> : <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>}
      </TD>
      <TD>
        {d.canEditPrices ? (
          <span className="flex flex-col gap-1">
            <Input className="h-8 w-28" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`Price for ${v.label} (₹)`} />
            <Input className="h-8" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Price starts (empty = now)" title="Price starts (empty = now)" />
          </span>
        ) : <Money paise={v.price} />}
        {v.scheduled.map((s) => (
          <span key={s.id} className="block text-xs text-junior">
            → {formatINR(s.price)} from {fmtDateTime(s.effectiveAt)}
            {d.canEditPrices ? (
              <Button
                size="sm" variant="ghost" className="ml-1 h-6 px-1 text-xs" aria-label={`Withdraw ${formatINR(s.price)} from ${fmtDateTime(s.effectiveAt)}`}
                onClick={async () => { setError(null); try { await api(`/api/pricing/prices/${s.id}`, { method: "DELETE" }); onDone(); } catch (e) { setError(toErr(e)); } }}
              >
                Withdraw
              </Button>
            ) : null}
          </span>
        ))}
      </TD>
      <TD className="text-right tabular">{d.trackStock ? `${v.available} (${v.onHand} on hand)` : "—"}</TD>
      <TD><Input className="h-8 w-20" inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} disabled={!d.canEdit} aria-label="Reorder level" /></TD>
      <TD className="text-xs">
        {v.taxCategory.replace("_", " ")} · {d.canEdit ? <Input className="mt-1 h-7 w-24 text-xs" value={hsn} onChange={(e) => setHsn(e.target.value)} aria-label={`HSN/SAC for ${v.label}`} /> : v.hsnSac}
      </TD>
      <TD>{d.canEdit ? <Button size="sm" variant="outline" onClick={save}>Save</Button> : null}{saved ? <span className="block text-xs text-success-text">Saved</span> : null}<RejectionBanner error={error} /></TD>
    </TR>
  );
}

function NewVariant({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [f, setF] = useState({ sku: "", label: "", price: "", hsnSac: d.variants[0]?.hsnSac ?? "9506" });
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  if (!d.canEditPrices) return null;
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      const price = parseRupees(f.price);
      if (price === null) return setError({ message: "Enter a price." });
      try { await api(`/api/shop/products/${d.id}/variants`, { body: { ...f, price } }); setF({ ...f, sku: "", label: "", price: "" }); onDone(); } catch (err) { setError(toErr(err)); }
    }}>
      <Field label="SKU"><Input className="h-9 w-32" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} required /></Field>
      <Field label="Size / colour"><Input className="h-9 w-32" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /></Field>
      <Field label="Price ₹"><Input className="h-9 w-24" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></Field>
      <Field label="HSN/SAC"><Input className="h-9 w-24" value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} required /></Field>
      <Button type="submit" size="sm" variant="outline">Add size / colour</Button>
      <RejectionBanner error={error} />
    </form>
  );
}

function Discounts({ d, onDone }: { d: Detail; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <DiscountList discounts={d.promotions} canEnd={d.canEditPrices} onDone={onDone} empty="No discount applies to this product." />
      {d.canEditPrices ? <DiscountForm endpoint={`/api/shop/products/${d.id}/promotions`} staffLimitPct={d.staffLimitPct} onDone={onDone} /> : null}
      <p className="text-xs text-muted-foreground">Category-wide and shop-wide discounts are on the <Link className="underline" href="/app/shop/products">products list</Link>.</p>
    </div>
  );
}

export function ProductEditor({ id }: { id: string }) {
  const state = useApi<Detail>(`/api/shop/products/${id}`);
  const reload = () => void state.reload();
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <PageHeader
            title={d.name}
            subtitle={<>{[d.brand, nice(d.category)].filter(Boolean).join(" · ")}{d.archivedAt ? " · archived (hidden from sale)" : ""}</>}
            actions={
              <>
                <Button asChild variant="ghost"><Link href="/app/shop/products">All products</Link></Button>
                {d.canEdit ? (
                  d.archivedAt
                    ? <Button variant="outline" onClick={async () => { setError(null); try { await api(`/api/shop/products/${d.id}/restore`, { body: {} }); reload(); } catch (e) { setError(toErr(e)); } }}>Restore</Button>
                    : <Button variant="outline" onClick={async () => { setError(null); try { await api(`/api/shop/products/${d.id}/archive`, { body: {} }); reload(); } catch (e) { setError(toErr(e)); } }}>Archive</Button>
                ) : null}
              </>
            }
          />
          <RejectionBanner error={error} />
          <Card><CardHeader><CardTitle>Photos</CardTitle></CardHeader><CardContent><Photos d={d} onDone={reload} /></CardContent></Card>
          <Card><CardHeader><CardTitle>Details</CardTitle></CardHeader><CardContent><Details d={d} onDone={reload} /></CardContent></Card>
          <Card>
            <CardHeader><CardTitle>Sizes, colours & prices</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Table>
                <THead><TR><TH>Size / colour</TH><TH>Price</TH><TH className="text-right">Available</TH><TH>Reorder at</TH><TH>Tax</TH><TH /></TR></THead>
                <TBody>{d.variants.map((v) => <VariantRow key={v.id} d={d} v={v} onDone={reload} />)}</TBody>
              </Table>
              <p className="text-xs text-muted-foreground">Stock changes through <Link className="underline" href="/app/shop/stock">receipts and adjustments</Link> or a stock take — never here.{d.canEditPrices ? " A new price starts now, or from the date and time you choose; every change is kept in the price history." : " Prices are set by shop staff or the owner."}</p>
              <NewVariant d={d} onDone={reload} />
            </CardContent>
          </Card>
          <Card><CardHeader><CardTitle>Discounts</CardTitle></CardHeader><CardContent><Discounts d={d} onDone={reload} /></CardContent></Card>
        </div>
      )}
    </DataState>
  );
}
