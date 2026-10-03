"use client";
// D-79: shop discounts (price-book promotions on shop products) — for one product on its page, or for categories / the
// whole shop on the products list. Shop staff start one at once up to their limit; above it, it waits for a Manager or
// the Owner. The server checks everything; this only collects the fields.
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { formatINR } from "@/lib/money";

export type DiscountView = {
  id: string; code: string; name: string; pct: number | null; flat: number | null; window: string; when: string;
  categories: string[]; productIds: string[]; audience: string; tiers: string[]; status: string; inEffect: boolean; own?: boolean;
};

const CATEGORIES = ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const toErr = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function scopeText(d: DiscountView) {
  if (d.productIds.length) return d.own === false ? "another product" : "this product";
  return d.categories.length ? d.categories.map(nice).join(", ") : "the whole shop";
}

/** The discounts that apply; `canEnd` shows an End button (the server still checks). */
export function DiscountList({ discounts, canEnd, onDone, empty }: { discounts: DiscountView[]; canEnd: boolean; onDone: () => void; empty: string }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  if (!discounts.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 text-sm" data-testid="discount-list">
        {discounts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.name}</span> {p.pct ? `−${p.pct}%` : p.flat ? `−${formatINR(p.flat)}` : ""} {p.window}
            {p.when ? <span className="text-xs text-muted-foreground">{p.when}</span> : null}
            <span className="text-xs text-muted-foreground">· {scopeText(p)}{p.audience === "WALK_IN" ? " · walk-ins" : p.audience === "TIERS" ? ` · ${p.tiers.map(nice).join(", ")}` : ""}</span>
            {p.status === "PENDING_APPROVAL" ? <Badge tone="amber">Awaiting approval</Badge> : p.inEffect ? <Badge tone="green">In effect</Badge> : <Badge tone="blue">Scheduled</Badge>}
            {canEnd ? (
              <Button
                size="sm" variant="ghost" className="h-7" aria-label={`End discount ${p.name}`}
                onClick={async () => { setError(null); try { await api(`/api/shop/discounts/${p.id}/end`, { body: {} }); onDone(); } catch (e) { setError(toErr(e)); } }}
              >
                End
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <RejectionBanner error={error} />
    </div>
  );
}

/** New discount: % off, optional dates, days and time band; `endpoint` decides one product or categories. */
export function DiscountForm({ endpoint, withCategories, staffLimitPct, onDone }: { endpoint: string; withCategories?: boolean; staffLimitPct: number; onDone: () => void }) {
  const blank = { name: "", pct: "10", dateFrom: "", dateTo: "", startTime: "", endTime: "", days: [] as number[], categories: [] as string[], audience: "ALL" };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="discount-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setMsg(null);
        try {
          const r = await api<{ code: string; status: string; approvalNeeded: string | null }>(endpoint, {
            body: {
              name: f.name, pct: Number(f.pct), dateFrom: f.dateFrom || undefined, dateTo: f.dateTo || undefined, startTime: f.startTime || undefined, endTime: f.endTime || undefined,
              daysOfWeek: f.days, audience: f.audience, ...(withCategories ? { categories: f.categories } : {}),
            },
          });
          setMsg(r.status === "PENDING_APPROVAL" ? `Saved (${r.code}) — waiting for approval (${r.approvalNeeded}).` : `Discount ${r.code} saved — the shop and checkout use it.`);
          setF(blank);
          onDone();
        } catch (err) { setError(toErr(err)); }
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Discount name"><Input className="h-9" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="% off"><Input className="h-9 w-20" inputMode="numeric" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} required /></Field>
        <Field label="From"><Input className="h-9" type="date" value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} /></Field>
        <Field label="Until"><Input className="h-9" type="date" value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} /></Field>
        <Field label="Daily from"><Input className="h-9 w-28" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
        <Field label="Daily until"><Input className="h-9 w-28" type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
        <Field label="For">
          <Select className="h-9" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
            <option value="ALL">Everyone</option>
            <option value="WALK_IN">Walk-ins only</option>
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-wrap items-center gap-2 text-sm">
        <legend className="sr-only">Days of the week</legend>
        <span className="font-semibold">Days</span>
        {DAYS.map((d, i) => (
          <label key={d} className="flex items-center gap-1">
            <input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i) })} /> {d}
          </label>
        ))}
        <span className="text-xs text-muted-foreground">(none = every day)</span>
      </fieldset>
      {withCategories ? (
        <fieldset className="flex flex-wrap items-center gap-2 text-sm">
          <legend className="sr-only">Categories</legend>
          <span className="font-semibold">Categories</span>
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={f.categories.includes(c)} onChange={(e) => setF({ ...f, categories: e.target.checked ? [...f.categories, c] : f.categories.filter((x) => x !== c) })} /> {nice(c)}
            </label>
          ))}
          <span className="text-xs text-muted-foreground">(none = the whole shop)</span>
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">Up to {staffLimitPct}% starts at once; above that it waits for a manager or the owner. Customers get the single best of their plan discount and any discount — never both.</p>
      <Button type="submit" size="sm" variant="outline" className="self-start">Add discount</Button>
      {msg ? <p className="text-sm text-success-text">{msg}</p> : null}
      <RejectionBanner error={error} />
    </form>
  );
}
