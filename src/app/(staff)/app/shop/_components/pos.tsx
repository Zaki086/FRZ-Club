"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Trash2, X, Receipt, ScanBarcode, Split } from "lucide-react";
import { QrScanner } from "@/components/qr-scanner";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { Money } from "@/components/money";
import {
  categoryLabel, QuoteLines, SHOP_CATEGORIES, StockLabel, useShopQuote,
  type CartItem, type CatalogueProduct, type CatalogueVariant, type QuoteLine,
} from "@/components/shop-quote";
import { formatINR, parseRupees } from "@/lib/money";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, UpiQr, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { METHOD_LABEL } from "@/components/capabilities";

type MemberHit = { id: string; memberCode: string; name: string; phone: string; status: MemberStatus };
type CartRow = CartItem & { name: string; isRestring: boolean; stockLabel: string };
type PayRow = TenderDraft;
type SaleResult = { code: string; billId: string; total: number; discountTotal: number; changeGiven: number; tickets: string[]; lines: QuoteLine[] };

function variantName(p: CatalogueProduct, v: CatalogueVariant) {
  return `${p.name}${v.label !== "Standard" ? ` — ${v.label}` : ""}`;
}

export function CounterPos() {
  const catalogue = useApi<CatalogueProduct[]>("/api/shop/catalogue");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [cart, setCart] = useState<CartRow[]>([]);
  const [member, setMember] = useState<MemberHit | null>(null);
  const [memberQ, setMemberQ] = useState("");
  const [memberTerm, setMemberTerm] = useState("");
  const [walkName, setWalkName] = useState("");
  const [walkPhone, setWalkPhone] = useState("");
  const [racket, setRacket] = useState("");
  const [notes, setNotes] = useState("");
  const [split, setSplit] = useState(false);
  const methods = useTenderMethods() ?? ["CASH"];
  const [single, setSingle] = useState<PayRow>(emptyTender("CASH"));
  const [rows, setRows] = useState<PayRow[]>([emptyTender("CASH"), emptyTender("CASH")]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<SaleResult | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMemberTerm(memberQ.trim()), 250);
    return () => clearTimeout(t);
  }, [memberQ]);
  const memberHits = useApi<MemberHit[]>(!member && memberTerm.length >= 2 ? `/api/members?q=${encodeURIComponent(memberTerm)}` : null);

  const items = useMemo(() => cart.map((c) => ({ variantId: c.variantId, qty: c.qty })), [cart]);
  const quoteReq = useMemo(() => (items.length ? { memberId: member?.id ?? undefined, items } : null), [items, member]);
  const { quote, error: quoteError, loading } = useShopQuote(quoteReq);
  const hasRestring = cart.some((c) => c.isRestring);

  const filtered = (catalogue.data ?? []).filter(
    (p) =>
      (!cat || p.category === cat) &&
      (!q.trim() || `${p.name} ${p.brand} ${p.variants.map((v) => `${v.sku} ${v.label}`).join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  const add = (p: CatalogueProduct, v: CatalogueVariant) => {
    if (!v.inStock) return;
    setResult(null);
    setCart((c) => {
      const ex = c.find((x) => x.variantId === v.id);
      if (ex) return c.map((x) => (x.variantId === v.id ? { ...x, qty: x.qty + 1 } : x));
      return [...c, { variantId: v.id, qty: 1, name: variantName(p, v), isRestring: p.isRestring, stockLabel: v.stockLabel }];
    });
  };
  /** Completion pass P2: add the item whose barcode or SKU is exactly `code`. */
  const addByCode = (code: string): boolean => {
    const c = code.trim().toLowerCase();
    if (!c) return false;
    for (const p of catalogue.data ?? []) {
      const v = p.variants.find((x) => x.sku.toLowerCase() === c || (x.barcode ?? "").toLowerCase() === c);
      if (v) {
        if (!v.inStock) {
          setError({ code: "INSUFFICIENT_STOCK", message: `${variantName(p, v)} is out of stock.` });
          return true;
        }
        add(p, v);
        setQ("");
        return true;
      }
    }
    return false;
  };
  const setQty = (id: string, qty: number) => setCart((c) => (qty <= 0 ? c.filter((x) => x.variantId !== id) : c.map((x) => (x.variantId === id ? { ...x, qty } : x))));

  const reset = () => {
    setCart([]);
    setMember(null);
    setMemberQ("");
    setWalkName("");
    setWalkPhone("");
    setRacket("");
    setNotes("");
    setSplit(false);
    setSingle(emptyTender("CASH"));
    setRows([emptyTender("CASH"), emptyTender(methods.find((m) => m !== "CASH") ?? "CASH")]);
    setError(null);
    searchRef.current?.focus();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payments = split
        ? rows.map((r) => {
            const amount = parseRupees(r.amount);
            if (!amount) throw new ApiError("VALIDATION_FAILED", "Enter an amount for every split payment row.", 422, null);
            return { ...tenderProof(r), amount };
          })
        : [tenderProof(single)];
      const r = await api<SaleResult>("/api/shop/counter-sale", {
        body: {
          memberId: member?.id,
          customerName: member ? undefined : walkName || undefined,
          customerPhone: member ? undefined : walkPhone || undefined,
          items,
          payments,
          restring: hasRestring ? { racket, notes } : undefined,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      setResult(r);
      reset();
      await catalogue.reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="xl:col-span-3">
        <CardContent className="flex flex-col gap-3 pt-4">
          <Input
            ref={searchRef}
            className="h-14 text-lg"
            placeholder="Search, or scan a barcode — Enter adds the item"
            value={q}
            autoFocus
            data-testid="pos-search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // A barcode scanner types the code and presses Enter: an exact barcode/SKU match wins.
              if (addByCode(q)) return;
              for (const p of filtered) {
                const v = p.variants.find((x) => x.inStock);
                if (v) {
                  add(p, v);
                  setQ("");
                  return;
                }
              }
            }}
          />
          {scanning ? (
            <QrScanner
              onScan={(text) => {
                setScanning(false);
                if (!addByCode(text)) setError({ code: "NOT_FOUND", message: `No item has the barcode or SKU ${text}.` });
              }}
              onClose={() => setScanning(false)}
            />
          ) : null}
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setScanning(true)}><ScanBarcode className="h-4 w-4" /> Scan</Button>
            <Button size="sm" variant={cat === "" ? "default" : "outline"} onClick={() => setCat("")}>All</Button>
            {SHOP_CATEGORIES.map((c) => (
              <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => setCat(c)}>
                {categoryLabel(c)}
              </Button>
            ))}
          </div>
          <DataState state={catalogue} isEmpty={() => filtered.length === 0} empty={{ title: "No products match", hint: "Try another search or category." }}>
            {() => (
              <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {filtered.flatMap((p) =>
                  p.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      disabled={!v.inStock}
                      onClick={() => add(p, v)}
                      className={cn(
                        "flex min-h-24 flex-col items-start gap-1 rounded-lg border bg-card p-3 text-left text-sm transition-colors",
                        v.inStock ? "hover:border-primary hover:bg-accent" : "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span className="font-semibold leading-tight">{variantName(p, v)}</span>
                      <span className="text-xs text-muted-foreground">{p.brand} · {v.sku}</span>
                      <span className="mt-auto flex w-full items-center justify-between gap-1">
                        <Money paise={v.price} className="font-semibold" />
                        <StockLabel label={v.available !== null && v.inStock && !v.stockLabel.startsWith("Only") ? `${v.available} avail.` : v.stockLabel} inStock={v.inStock} />
                      </span>
                    </button>
                  )),
                )}
              </div>
            )}
          </DataState>
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Sale</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {result ? (
            <div className="flex flex-col gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm" data-testid="sale-receipt">
              <p className="flex items-center gap-2 text-base font-semibold"><Receipt className="h-4 w-4" /> Sale {result.code} complete
                <a className="ml-auto text-sm font-normal text-primary underline" href={`/print/bill/${result.billId}`} target="_blank" rel="noreferrer">Print receipt</a>
              </p>
              {result.lines.map((l, i) => (
                <p key={i} className="flex justify-between gap-2">
                  <span>{l.qty} × {l.description}</span>
                  <Money paise={l.netAmount} />
                </p>
              ))}
              <p className="flex justify-between font-semibold"><span>Total</span><Money paise={result.total} /></p>
              {result.discountTotal ? <p className="text-green-800">Member discount: {formatINR(result.discountTotal)}</p> : null}
              {result.changeGiven ? <p className="text-lg font-bold">Change to give: {formatINR(result.changeGiven)}</p> : null}
              {result.tickets.length ? <p>Restring ticket{result.tickets.length > 1 ? "s" : ""}: {result.tickets.join(", ")}</p> : null}
              <Button size="sm" variant="outline" onClick={() => setResult(null)}>Dismiss</Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Customer</p>
            {member ? (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-accent/40 p-2 text-sm">
                <div>
                  <p className="font-semibold">{member.name} <span className="font-mono text-xs text-muted-foreground">{member.memberCode}</span></p>
                  <MemberStatusBadge status={member.status} />
                </div>
                <Button size="icon" variant="ghost" aria-label="Remove member" onClick={() => setMember(null)}><X className="h-4 w-4" /></Button>
              </div>
            ) : (
              <>
                <Input placeholder="Member name, phone or code (for the plan discount)" value={memberQ} onChange={(e) => setMemberQ(e.target.value)} data-testid="pos-member-search" />
                {memberTerm.length >= 2 ? (
                  <div className="max-h-40 divide-y overflow-y-auto rounded-md border">
                    {(memberHits.data ?? []).map((m) => (
                      <button key={m.id} type="button" className="flex w-full items-center justify-between gap-2 p-2 text-left text-sm hover:bg-muted" onClick={() => { setMember(m); setMemberQ(""); }}>
                        <span>{m.name} <span className="font-mono text-xs text-muted-foreground">{m.memberCode}</span></span>
                        <MemberStatusBadge status={m.status} />
                      </button>
                    ))}
                    {memberHits.data && memberHits.data.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No member found.</p> : null}
                    {memberHits.error ? <p className="p-2 text-sm text-destructive">{memberHits.error.message}</p> : null}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="Walk-in name (optional)" value={walkName} onChange={(e) => setWalkName(e.target.value)} />
                  <Input placeholder="Walk-in phone (optional)" inputMode="tel" value={walkPhone} onChange={(e) => setWalkPhone(e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div className="divide-y rounded-md border">
            {cart.length === 0 ? <p className="p-3 text-sm text-muted-foreground">Cart is empty — tap a product to add it.</p> : null}
            {cart.map((c) => (
              <div key={c.variantId} className="flex items-center gap-2 p-2 text-sm">
                <span className="flex-1 font-medium">{c.name}</span>
                <Button size="icon" variant="outline" aria-label="Less" onClick={() => setQty(c.variantId, c.qty - 1)}><Minus className="h-4 w-4" /></Button>
                <span className="w-6 text-center font-semibold tabular">{c.qty}</span>
                <Button size="icon" variant="outline" aria-label="More" onClick={() => setQty(c.variantId, c.qty + 1)}><Plus className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setQty(c.variantId, 0)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>

          {cart.length ? <QuoteLines quote={quote} error={quoteError} loading={loading} /> : null}

          {hasRestring ? (
            <div className="grid gap-2 rounded-md border border-blue-200 bg-blue-50 p-2">
              <p className="text-sm font-medium">Restringing ticket (needs a member or a walk-in phone)</p>
              <Input placeholder="Racket (e.g. Wilson Blade 98)" value={racket} onChange={(e) => setRacket(e.target.value)} />
              <Input placeholder="Notes (string, tension)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          ) : null}

          {cart.length ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Payment (in full)</p>
                {methods.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => { if (!split) setRows([emptyTender("CASH"), emptyTender(methods.find((m) => m !== "CASH") ?? "CASH")]); setSplit(!split); }}><Split className="h-4 w-4" /> {split ? "Single payment" : "Split payment"}</Button>
                ) : null}
              </div>
              {!split ? (
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-3 flex gap-1">
                    {methods.map((m) => (
                      <Button key={m} type="button" className="flex-1" size="lg" variant={single.method === m ? "default" : "outline"} onClick={() => setSingle({ ...single, method: m })}>
                        {METHOD_LABEL[m]}
                      </Button>
                    ))}
                  </div>
                  <ProofFields className="col-span-3" value={single} due={quote?.total ?? null} onChange={(patch) => setSingle({ ...single, ...patch })} />
                  {single.method === "UPI" ? <div className="col-span-3"><UpiQr amountPaise={quote?.total ?? null} note="Shop sale" /></div> : null}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {rows.map((r, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2">
                      <MethodSelect className="col-span-12 sm:col-span-3" methods={methods} value={r.method} onChange={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, method: m } : x)))} />
                      <Input className="col-span-5 sm:col-span-3" inputMode="decimal" placeholder="₹" aria-label="Amount" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                      <ProofFields className="col-span-6 sm:col-span-5" value={r} onChange={(patch) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)))} />
                      <Button className="col-span-1" size="icon" variant="ghost" aria-label="Remove row" disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  {rows.length < 4 ? <Button size="sm" variant="outline" onClick={() => setRows([...rows, emptyTender(methods[methods.length - 1])])}><Plus className="h-4 w-4" /> Add row</Button> : null}
                  <p className="text-xs text-muted-foreground">Rows must add up exactly to the server total{quote ? ` (${formatINR(quote.total)})` : ""}.</p>
                </div>
              )}
              {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener defaultArea="SHOP" onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
              <Button size="xl" disabled={busy || !quote} onClick={submit} data-testid="pos-submit">
                {busy ? "Completing…" : quote ? `Complete sale · ${formatINR(quote.total)}` : "Complete sale"}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>Clear sale</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
