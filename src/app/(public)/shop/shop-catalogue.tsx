"use client";
import Link from "next/link";
import { useState } from "react";
import { ShoppingBag, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Empty } from "@/components/states";
import { categoryLabel, OfferPrice, StockLabel, type CatalogueProduct } from "@/components/shop-quote";
import { addToCart, useCart } from "@/components/cart";
import { ProductImage } from "@/components/product-image";

const CATS = ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL"];

export function ShopCatalogue({ products, initialCategory }: { products: CatalogueProduct[]; initialCategory: string }) {
  const [cat, setCat] = useState(CATS.includes(initialCategory) ? initialCategory : "");
  const [q, setQ] = useState("");
  const cart = useCart();
  const shown = products.filter((p) => (!cat || p.category === cat) && (!q.trim() || `${p.name} ${p.brand}`.toLowerCase().includes(q.trim().toLowerCase())));
  const count = cart.reduce((a, l) => a + l.qty, 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={cat === "" ? "default" : "outline"} onClick={() => setCat("")}>All</Button>
        {CATS.map((c) => (
          <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => setCat(c)}>{categoryLabel(c)}</Button>
        ))}
        <Input className="w-full sm:ml-auto sm:w-56" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {count ? (
        <Link href="/shop/cart" className="flex items-center justify-between rounded-md border border-primary bg-accent px-3 py-2 text-sm font-medium">
          <span className="flex items-center gap-2"><ShoppingBag className="h-4 w-4" /> {count} item{count > 1 ? "s" : ""} in your cart</span>
          <span className="text-primary underline">View cart</span>
        </Link>
      ) : null}
      {shown.length === 0 ? (
        <Empty title="Nothing matches" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => {
            const first = p.variants[0];
            const inCart = cart.some((l) => p.variants.some((v) => v.id === l.variantId));
            const single = p.variants.length === 1;
            return (
              <Card key={p.id} className="flex flex-col gap-2 p-4">
                <Link href={`/shop/${p.id}`} aria-hidden tabIndex={-1}>
                  <ProductImage url={p.imageUrl} category={p.category} name={p.name} className="aspect-[4/3] w-full" />
                </Link>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{p.brand} · {categoryLabel(p.category)}</p>
                    <Link href={`/shop/${p.id}`} className="text-lg font-semibold hover:underline">{p.name}</Link>
                  </div>
                  <OfferPrice v={first} className="text-lg font-bold" />
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
                <div className="flex flex-wrap gap-1">
                  {p.variants.map((v) => (
                    <span key={v.id} className="inline-flex items-center gap-1 text-xs">
                      {!single ? <span className="font-medium">{v.label}</span> : null}
                      <StockLabel label={v.stockLabel} inStock={v.inStock} />
                    </span>
                  ))}
                </div>
                <div className="mt-auto flex gap-2 pt-2">
                  {single ? (
                    <Button className="flex-1" disabled={!first.inStock} onClick={() => addToCart({ variantId: first.id, name: p.name })}>
                      {inCart ? <><Check className="h-4 w-4" /> Add another</> : first.inStock ? "Add to cart" : "Out of stock"}
                    </Button>
                  ) : (
                    <Button asChild className="flex-1"><Link href={`/shop/${p.id}`}>Choose size</Link></Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
