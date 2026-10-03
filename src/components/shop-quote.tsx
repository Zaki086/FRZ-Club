"use client";
// Shop quote preview (PR-9). The server prices every line; checkout and counter sales recompute anyway.
import { useEffect, useState } from "react";
import { formatINR } from "@/lib/money";
import { api, ApiError } from "./api";
import { Money } from "./money";
import { RejectionBanner } from "./states";

/** `offerPrice`/`offer`: what a walk-in pays right now under a shop discount (the engine's price; null = no discount). */
export type CatalogueVariant = { id: string; sku: string; barcode?: string | null; label: string; price: number; offerPrice?: number | null; offer?: string | null; available: number | null; stockLabel: string; inStock: boolean };

/** The catalogue price: struck through with the discounted price beside it while a shop discount is on. */
export function OfferPrice({ v, className }: { v: Pick<CatalogueVariant, "price" | "offerPrice" | "offer">; className?: string }) {
  if (v.offerPrice === null || v.offerPrice === undefined) return <Money paise={v.price} className={className} />;
  return (
    <span className="inline-flex flex-col items-end" data-testid="offer-price">
      <span className={className}>
        <s className="mr-1 text-sm font-normal text-muted-foreground" aria-label={`was ${formatINR(v.price)}`}>{formatINR(v.price)}</s>
        <Money paise={v.offerPrice} />
      </span>
      {v.offer ? <span className="text-xs font-medium text-success-text">{v.offer}</span> : null}
    </span>
  );
}
export type CatalogueProduct = {
  id: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  imageUrl: string | null;
  trackStock: boolean;
  isRestring: boolean;
  variants: CatalogueVariant[];
};
export type QuoteLine = {
  description: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  netAmount: number;
  taxAmount: number;
  explanation: string;
  variantId?: string | null;
};
export type ShopQuote = { tier: string; lines: QuoteLine[]; total: number; taxTotal: number; discountTotal: number };
export type CartItem = { variantId: string; qty: number };

export function useShopQuote(req: { memberId?: string | null; items: CartItem[]; fulfilment?: "PICKUP" | "DELIVERY" } | null) {
  const key = req && req.items.length ? JSON.stringify(req) : null;
  const [state, setState] = useState<{ key: string; data?: ShopQuote; error?: { code?: string; message: string } } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<ShopQuote>("/api/shop/quote", { body: JSON.parse(key) })
        .then((d) => {
          if (!cancelled) setState({ key, data: d });
        })
        .catch((e) => {
          if (!cancelled) setState({ key, error: e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) } });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);
  const current = key && state?.key === key ? state : null;
  return { quote: current?.data, error: current?.error ?? null, loading: !!key && !current };
}

export function QuoteLines({ quote, error, loading }: { quote?: ShopQuote; error: { code?: string; message: string } | null; loading: boolean }) {
  if (error) return <RejectionBanner error={error} />;
  if (!quote) return <p className="text-sm text-muted-foreground">{loading ? "Pricing…" : "Add items to see the price."}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="shop-quote">
      <div className="divide-y rounded-md border">
        {quote.lines.map((l, i) => (
          <div key={i} className="flex items-start justify-between gap-2 p-2 text-sm">
            <div>
              <p className="font-medium">
                {l.qty > 1 ? `${l.qty} × ` : ""}
                {l.description}
              </p>
              <p className="text-xs text-muted-foreground">{l.explanation}</p>
            </div>
            <div className="text-right">
              <Money paise={l.netAmount} className="font-medium" />
              {l.discountAmount ? <p className="text-xs text-success-text">−{formatINR(l.discountAmount)}</p> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">You save</span>
        <Money paise={quote.discountTotal} />
      </div>
      <div className="flex justify-between text-lg font-bold">
        <span>Total (GST incl. {formatINR(quote.taxTotal)})</span>
        <Money paise={quote.total} />
      </div>
    </div>
  );
}

export { SHOP_CATEGORIES, categoryLabel } from "./shop-categories";

export function StockLabel({ label, inStock }: { label: string; inStock: boolean }) {
  const tone = !inStock ? "bg-destructive/10 text-destructive" : label.startsWith("Only") ? "bg-warning/15 text-warning-text" : label === "Service" ? "bg-junior/10 text-junior" : "bg-success/10 text-success-text";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
}
