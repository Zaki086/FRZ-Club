"use client";
// v3 §9.2: the price book. Base prices (court and social fee per tier, menu prices; product prices on each product's
// page), time bands, special dates, promotions with approval, guardrails (Owner) and the price simulator (PR-13).
// Every number shown comes from the server; the simulator calls the real pricing engine.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Money } from "@/components/money";
import { formatINR, parseRupees } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

type Price = { target: string; price: number; scheduled: Array<{ id: string; price: number; effectiveAt: string }> };
type Rule = {
  id: string; code: string; kind: string; name: string; scope: string; sports: string[]; courtIds: string[]; productCategories: string[]; menuCategories: string[];
  daysOfWeek: number[]; window: string; dateFrom: string | null; dateTo: string | null; adjustType: string; adjustPct: number | null; fixedPrices: Record<string, number> | null;
  flatAmount: number | null; audience: string; tiers: string[]; priority: number; status: string; state: string; effectiveFrom: string; effectiveTo: string | null;
  createdByName: string | null; approvedByName: string | null; createdBy: string | null;
};
type Book = {
  now: string; canGuardrails: boolean; guardrails: { maxManagerDiscountPct: number; maxStaffDiscountPct: number };
  fees: Array<{ tier: string; court: Record<string, Price>; social: Price }>;
  menu: Array<{ id: string; target: string; name: string; category: string; price: number; scheduled: Price["scheduled"] }>;
  rules: Rule[];
  courts: Array<{ id: string; name: string; sport: string }>;
  products: Array<{ id: string }>;
};

const TIERS = ["GOLD", "SILVER", "JUNIOR", "WALK_IN"];
const SPORTS = ["TENNIS", "CRICKET", "PADEL", "BADMINTON"];
const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace("_", "-");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATE: Record<string, { label: string; tone: "green" | "amber" | "blue" | "neutral" | "red" }> = {
  IN_EFFECT: { label: "In effect", tone: "green" }, SCHEDULED: { label: "Scheduled", tone: "blue" }, PENDING_APPROVAL: { label: "Awaiting approval", tone: "amber" },
  ENDED: { label: "Ended", tone: "neutral" }, REJECTED: { label: "Rejected", tone: "red" },
};

function toErr(e: unknown) {
  return e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) };
}

/** A price with its scheduled changes; editing makes a new version (now or at a chosen time). */
function PriceCell({ p, label, onDone }: { p: Price; label: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState((p.price / 100).toFixed(0));
  const [when, setWhen] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  if (!open) {
    return (
      <button type="button" className="text-left hover:underline" onClick={() => setOpen(true)} aria-label={`Change ${label}`}>
        <Money paise={p.price} className="font-semibold" />
        {p.scheduled.map((s) => <span key={s.id} className="block text-xs text-junior">→ {formatINR(s.price)} from {fmtDateTime(s.effectiveAt)}</span>)}
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const paise = parseRupees(value);
        if (paise === null) return setError({ message: "Enter a price in ₹." });
        try {
          await api("/api/pricing/prices", { body: { target: p.target, price: paise, effectiveAt: when ? new Date(`${when}:00+05:30`).toISOString() : undefined } });
          setOpen(false);
          onDone();
        } catch (err) {
          setError(toErr(err));
        }
      }}
    >
      <Input className="h-8 w-24" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`New ${label} (₹)`} />
      <Input className="h-8" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Starts (empty = now)" title="Starts (empty = now)" />
      <span className="flex gap-1"><Button size="sm" type="submit">Save</Button><Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></span>
      {p.scheduled.map((s) => (
        <Button key={s.id} size="sm" type="button" variant="ghost" onClick={async () => { await api(`/api/pricing/prices/${s.id}`, { method: "DELETE" }); onDone(); }}>Withdraw {formatINR(s.price)} from {fmtDateTime(s.effectiveAt)}</Button>
      ))}
      <RejectionBanner error={error} />
    </form>
  );
}

function ruleSummary(r: Rule, courts: Book["courts"]) {
  const scope = r.scope === "COURTS"
    ? [r.sports.map(nice).join(", "), r.courtIds.map((id) => courts.find((c) => c.id === id)?.name).filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "All courts"
    : r.scope === "SOCIAL" ? "Social play" : r.scope === "PRODUCTS" ? (r.productCategories.map(nice).join(", ") || "Shop") : (r.menuCategories.map(nice).join(", ") || "Bar & café");
  const days = r.daysOfWeek.length && r.daysOfWeek.length < 7 ? r.daysOfWeek.map((d) => DAYS[d]).join(" ") : "";
  const when = [r.kind === "SPECIAL_DATE" ? r.dateFrom : [r.dateFrom, r.dateTo].filter(Boolean).join(" → "), days, r.window].filter(Boolean).join(" · ");
  const how = r.adjustType === "FIXED" ? Object.entries(r.fixedPrices ?? {}).map(([t, v]) => `${nice(t)} ${formatINR(v)}`).join(", ")
    : r.adjustType === "FLAT" ? `−${formatINR(r.flatAmount ?? 0)}` : r.kind === "PROMOTION" ? `−${r.adjustPct}%` : `${(r.adjustPct ?? 0) > 0 ? "+" : "−"}${Math.abs(r.adjustPct ?? 0)}%`;
  const who = r.audience === "WALK_IN" ? "walk-ins" : r.audience === "TIERS" ? r.tiers.map(nice).join(", ") : "";
  return { scope, when, how, who };
}

function RuleForm({ book, onDone }: { book: Book; onDone: () => void }) {
  const [f, setF] = useState({ kind: "BAND", name: "", scope: "COURTS", sport: "", courtId: "", category: "", days: [1, 2, 3, 4, 5] as number[], startTime: "18:00", endTime: "21:00", dateFrom: "", dateTo: "", adjustType: "PCT", pct: "20", fixed: "", flat: "", audience: "ALL", tier: "WALK_IN", from: "" });
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: unknown) => setF({ ...f, [k]: v });
  const isPromo = f.kind === "PROMOTION";
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="rule-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setMsg(null);
        try {
          const body: Record<string, unknown> = {
            kind: f.kind, name: f.name, scope: f.scope, audience: f.audience, tiers: f.audience === "TIERS" ? [f.tier] : [],
            sports: f.scope === "COURTS" && f.sport ? [f.sport] : [], courtIds: f.scope === "COURTS" && f.courtId ? [f.courtId] : [],
            productCategories: f.scope === "PRODUCTS" && f.category ? [f.category] : [], menuCategories: f.scope === "MENU" && f.category ? [f.category] : [],
            daysOfWeek: f.kind === "SPECIAL_DATE" ? [] : f.days, startTime: f.startTime || undefined, endTime: f.endTime || undefined,
            dateFrom: f.dateFrom || undefined, dateTo: f.dateTo || undefined, adjustType: f.adjustType,
            adjustPct: f.adjustType === "PCT" ? Number(f.pct) : undefined,
            flatAmount: f.adjustType === "FLAT" ? parseRupees(f.flat) ?? undefined : undefined,
            fixedPrices: f.adjustType === "FIXED" ? { [f.tier]: parseRupees(f.fixed) ?? 0 } : undefined,
            effectiveFrom: f.from ? new Date(`${f.from}:00+05:30`).toISOString() : undefined,
          };
          const r = await api<{ code: string; status: string; approvalNeeded: string | null }>("/api/pricing/rules", { body });
          setMsg(r.status === "PENDING_APPROVAL" ? `${r.code} saved — waiting for approval (${r.approvalNeeded}).` : `${r.code} saved${f.from ? " — it starts at the chosen time" : " and in effect now"}.`);
          onDone();
        } catch (err) {
          setError(toErr(err));
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, adjustType: e.target.value === "PROMOTION" ? "PCT" : f.adjustType, scope: e.target.value === "PROMOTION" ? f.scope : f.scope === "PRODUCTS" || f.scope === "MENU" ? "COURTS" : f.scope })}>
            <option value="BAND">Time band</option><option value="SPECIAL_DATE">Special date</option><option value="PROMOTION">Promotion</option>
          </Select>
        </Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={isPromo ? "e.g. Happy hour" : "e.g. Peak"} required /></Field>
        <Field label="Applies to">
          <Select value={f.scope} onChange={(e) => set("scope", e.target.value)}>
            <option value="COURTS">Courts</option><option value="SOCIAL">Social play</option>
            {isPromo ? <><option value="PRODUCTS">Shop</option><option value="MENU">Bar & café</option></> : null}
          </Select>
        </Field>
        {f.scope === "COURTS" ? (
          <Field label="Sport / court">
            <Select value={f.courtId ? `c:${f.courtId}` : f.sport ? `s:${f.sport}` : ""} onChange={(e) => { const v = e.target.value; setF({ ...f, sport: v.startsWith("s:") ? v.slice(2) : "", courtId: v.startsWith("c:") ? v.slice(2) : "" }); }}>
              <option value="">All courts</option>
              {SPORTS.map((s) => <option key={s} value={`s:${s}`}>{nice(s)} (all courts)</option>)}
              {book.courts.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
            </Select>
          </Field>
        ) : f.scope === "PRODUCTS" || f.scope === "MENU" ? (
          <Field label="Category">
            <Select value={f.category} onChange={(e) => set("category", e.target.value)}>
              <option value="">Everything</option>
              {(f.scope === "PRODUCTS" ? ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"] : ["FOOD", "BEVERAGE", "ALCOHOL"]).map((c) => <option key={c} value={c}>{nice(c)}</option>)}
            </Select>
          </Field>
        ) : <span />}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {f.kind === "SPECIAL_DATE" ? (
          <Field label="Date"><Input type="date" value={f.dateFrom} onChange={(e) => set("dateFrom", e.target.value)} required /></Field>
        ) : (
          <fieldset className="flex flex-wrap items-end gap-2 text-sm sm:col-span-2">
            <legend className="text-sm font-semibold">Days</legend>
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={f.days.includes(i)} onChange={(e) => set("days", e.target.checked ? [...f.days, i].sort() : f.days.filter((x) => x !== i))} />{d}</label>
            ))}
          </fieldset>
        )}
        <Field label="From"><Input type="time" step={1800} value={f.startTime} onChange={(e) => set("startTime", e.target.value)} /></Field>
        <Field label="To"><Input type="time" step={1800} value={f.endTime} onChange={(e) => set("endTime", e.target.value)} /></Field>
        {isPromo ? (
          <>
            <Field label="Valid from (date)"><Input type="date" value={f.dateFrom} onChange={(e) => set("dateFrom", e.target.value)} /></Field>
            <Field label="Valid until (date)"><Input type="date" value={f.dateTo} onChange={(e) => set("dateTo", e.target.value)} /></Field>
          </>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Change">
          <Select value={f.adjustType} onChange={(e) => set("adjustType", e.target.value)}>
            <option value="PCT">{isPromo ? "% off" : "% up or down"}</option>
            {isPromo ? <option value="FLAT">₹ off</option> : <option value="FIXED">Fixed price</option>}
          </Select>
        </Field>
        {f.adjustType === "PCT" ? <Field label={isPromo ? "% off" : "% (e.g. 20 or -10)"}><Input inputMode="numeric" value={f.pct} onChange={(e) => set("pct", e.target.value)} required /></Field> : null}
        {f.adjustType === "FLAT" ? <Field label="₹ off"><Input inputMode="decimal" value={f.flat} onChange={(e) => set("flat", e.target.value)} required /></Field> : null}
        {f.adjustType === "FIXED" || f.audience === "TIERS" ? (
          <Field label="Tier">
            <Select value={f.tier} onChange={(e) => set("tier", e.target.value)}>{TIERS.map((t) => <option key={t} value={t}>{nice(t)}</option>)}</Select>
          </Field>
        ) : null}
        {f.adjustType === "FIXED" ? <Field label="Fixed price ₹"><Input inputMode="decimal" value={f.fixed} onChange={(e) => set("fixed", e.target.value)} required /></Field> : null}
        <Field label="For">
          <Select value={f.audience} onChange={(e) => set("audience", e.target.value)}>
            <option value="ALL">Everyone</option><option value="TIERS">One tier</option><option value="WALK_IN">Walk-ins</option>
          </Select>
        </Field>
        <Field label="Starts (empty = now)"><Input type="datetime-local" value={f.from} onChange={(e) => set("from", e.target.value)} /></Field>
      </div>
      <RejectionBanner error={error} />
      {msg ? <p className="text-sm text-success-text" data-testid="rule-saved">{msg}</p> : null}
      <Button type="submit" className="self-start">Save rule</Button>
    </form>
  );
}

function Rules({ book, onDone }: { book: Book; onDone: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onDone(); } catch (e) { setError(toErr(e)); } };
  if (!book.rules.length) return <p className="text-sm text-muted-foreground">No rules yet — prices are the base prices above.</p>;
  return (
    <div className="flex flex-col gap-2">
      <RejectionBanner error={error} />
      <Table>
        <THead><TR><TH>Rule</TH><TH>Applies to</TH><TH>When</TH><TH>Change</TH><TH>State</TH><TH /></TR></THead>
        <TBody>
          {book.rules.map((r) => {
            const s = ruleSummary(r, book.courts);
            return (
              <TR key={r.id}>
                <TD><span className="flex flex-col"><span className="font-semibold">{r.name}</span><span className="font-mono text-xs text-muted-foreground">{r.code} · {nice(r.kind.replace("_", " "))}</span></span></TD>
                <TD className="text-sm">{s.scope}{s.who ? ` · ${s.who}` : ""}</TD>
                <TD className="text-sm">{s.when || "Always"}</TD>
                <TD className="font-semibold">{s.how}</TD>
                <TD><Badge tone={STATE[r.state]?.tone ?? "neutral"}>{STATE[r.state]?.label ?? r.state}</Badge><span className="block text-xs text-muted-foreground">by {r.createdByName ?? "—"}{r.state === "SCHEDULED" ? ` · from ${fmtDateTime(r.effectiveFrom)}` : ""}</span></TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {r.status === "PENDING_APPROVAL" ? (
                      <>
                        <Button size="sm" onClick={() => act(() => api(`/api/pricing/rules/${r.id}/decide`, { body: { decision: "APPROVE" } }))}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/pricing/rules/${r.id}/decide`, { body: { decision: "REJECT" } }))}>Reject</Button>
                      </>
                    ) : null}
                    {r.state === "IN_EFFECT" || r.state === "SCHEDULED" ? <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/pricing/rules/${r.id}/end`, { body: {} }))}>End now</Button> : null}
                  </span>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

function Simulator({ book }: { book: Book }) {
  const [f, setF] = useState({ offering: "COURT", tier: "WALK_IN", date: book.now.slice(0, 10), time: "18:00", courtId: book.courts[0]?.id ?? "", menuItemId: book.menu[0]?.id ?? "" });
  const [r, setR] = useState<{ total: number; lines: Array<{ description: string; unitPrice: number; discount: number; net: number; explanation: string }> } | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="simulator"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try { setR(await api("/api/pricing/simulate", { body: f })); } catch (err) { setR(null); setError(toErr(err)); }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-5">
        <Field label="What"><Select value={f.offering} onChange={(e) => setF({ ...f, offering: e.target.value })}><option value="COURT">Court</option><option value="SOCIAL">Social play</option><option value="MENU">Bar & café</option></Select></Field>
        <Field label="Tier"><Select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>{TIERS.map((t) => <option key={t} value={t}>{nice(t)}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Time"><Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        {f.offering === "COURT" ? <Field label="Court"><Select value={f.courtId} onChange={(e) => setF({ ...f, courtId: e.target.value })}>{book.courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field> : null}
        {f.offering === "MENU" ? <Field label="Item"><Select value={f.menuItemId} onChange={(e) => setF({ ...f, menuItemId: e.target.value })}>{book.menu.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field> : null}
      </div>
      <Button type="submit" variant="outline" className="self-start">Show the price</Button>
      <RejectionBanner error={error} />
      {r ? (
        <div className="rounded-xl bg-secondary/50 p-3 text-sm" data-testid="simulator-result">
          <p className="font-display text-2xl font-bold"><Money paise={r.total} /></p>
          {r.lines.map((l, i) => <p key={i} className="text-muted-foreground">{l.explanation}</p>)}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">Shop prices: open a product in <Link className="underline" href="/app/shop/products">Products</Link>.</p>
    </form>
  );
}

function Guardrails({ book, onDone }: { book: Book; onDone: () => void }) {
  const [s, setS] = useState(String(book.guardrails.maxStaffDiscountPct));
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  // v4 RN-3: only the Owner prices, so the one limit left is the shop staff's (above it a discount waits for the Owner).
  if (!book.canGuardrails) return <p className="text-sm text-muted-foreground">Shop staff may give discounts up to {book.guardrails.maxStaffDiscountPct}%; above that they wait for the Owner. Only the Owner changes this limit.</p>;
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); setError(null); try { await api("/api/pricing/guardrails", { method: "PUT", body: { maxStaffDiscountPct: Number(s) } }); onDone(); } catch (err) { setError(toErr(err)); } }}>
      <Field label="Shop staff up to (%)" hint="Above this a shop discount waits for your approval"><Input className="w-24" inputMode="numeric" value={s} onChange={(e) => setS(e.target.value)} /></Field>
      <Button type="submit" variant="outline">Save limits</Button>
      <RejectionBanner error={error} />
    </form>
  );
}

export function PriceBook() {
  const state = useApi<Book>("/api/pricing");
  const reload = () => void state.reload();
  return (
    <DataState state={state}>
      {(b) => (
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Bands, dates & promotions</TabsTrigger>
            <TabsTrigger value="fees">Court & social fees</TabsTrigger>
            <TabsTrigger value="menu">Bar & café prices</TabsTrigger>
            <TabsTrigger value="simulate">Price simulator</TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="mt-3 flex flex-col gap-4">
            <Card><CardHeader><CardTitle>New rule</CardTitle></CardHeader><CardContent><RuleForm book={b} onDone={reload} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Rules</CardTitle></CardHeader><CardContent><Rules book={b} onDone={reload} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Promotion limits</CardTitle></CardHeader><CardContent><Guardrails book={b} onDone={reload} /></CardContent></Card>
          </TabsContent>
          <TabsContent value="fees" className="mt-3">
            <Table>
              <THead><TR><TH>Tier</TH>{SPORTS.map((s) => <TH key={s}>{nice(s)} (per player/hour)</TH>)}<TH>Social play</TH></TR></THead>
              <TBody>
                {b.fees.map((f) => (
                  <TR key={f.tier}>
                    <TD className="font-semibold">{nice(f.tier)}</TD>
                    {SPORTS.map((s) => <TD key={s}><PriceCell p={f.court[s]} label={`${nice(f.tier)} ${nice(s)} fee`} onDone={reload} /></TD>)}
                    <TD><PriceCell p={f.social} label={`${nice(f.tier)} social fee`} onDone={reload} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">Membership prices and plan discounts are on the plans in Settings (Owner).</p>
          </TabsContent>
          <TabsContent value="menu" className="mt-3">
            <Table>
              <THead><TR><TH>Item</TH><TH>Category</TH><TH>Price</TH></TR></THead>
              <TBody>
                {b.menu.map((m) => (
                  <TR key={m.id}><TD className="font-semibold">{m.name}</TD><TD>{nice(m.category)}</TD><TD><PriceCell p={m} label={`${m.name} price`} onDone={reload} /></TD></TR>
                ))}
              </TBody>
            </Table>
          </TabsContent>
          <TabsContent value="simulate" className="mt-3"><Card><CardContent className="pt-5"><Simulator book={b} /></CardContent></Card></TabsContent>
        </Tabs>
      )}
    </DataState>
  );
}
