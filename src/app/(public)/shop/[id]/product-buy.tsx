"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { StockLabel, type CatalogueProduct } from "@/components/shop-quote";
import { addToCart } from "@/components/cart";

export function ProductBuy({ product }: { product: CatalogueProduct }) {
  const [vid, setVid] = useState(product.variants.find((v) => v.inStock)?.id ?? product.variants[0].id);
  const [added, setAdded] = useState(false);
  const v = product.variants.find((x) => x.id === vid) ?? product.variants[0];
  return (
    <div className="mt-6 flex flex-col gap-4">
      {product.variants.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {product.variants.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => { setVid(x.id); setAdded(false); }}
              className={cn("flex min-w-20 flex-col items-center gap-1 rounded-lg border p-2 text-sm", vid === x.id ? "border-primary bg-accent ring-2 ring-primary" : "hover:bg-muted", !x.inStock && "opacity-60")}
            >
              <span className="font-semibold">{x.label}</span>
              <StockLabel label={x.stockLabel} inStock={x.inStock} />
            </button>
          ))}
        </div>
      ) : (
        <StockLabel label={v.stockLabel} inStock={v.inStock} />
      )}
      <p className="text-3xl font-bold"><Money paise={v.price} /></p>
      <p className="text-xs text-muted-foreground">Price includes GST. Member discounts are applied at checkout.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={!v.inStock} onClick={() => { addToCart({ variantId: v.id, name: `${product.name}${v.label !== "Standard" ? ` — ${v.label}` : ""}` }); setAdded(true); }}>
          {v.inStock ? "Add to cart" : "Out of stock"}
        </Button>
        {added ? <Button size="lg" variant="outline" asChild><Link href="/shop/cart">Go to cart</Link></Button> : null}
      </div>
    </div>
  );
}
