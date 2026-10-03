import type { Metadata } from "next";
import { PriceNotes } from "@/components/price-notes";
import { listCatalogue } from "@/server/services/shop";
import { ShopCatalogue } from "./shop-catalogue";

export const metadata: Metadata = { title: "Shop" };
export const dynamic = "force-dynamic";

export default async function ShopPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const sp = await searchParams;
  const products = (await listCatalogue()).filter((p) => p.category !== "SERVICES");
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold">Gear shop</h1>
      <p className="mb-4 text-muted-foreground">Rackets, balls, shoes, accessories and apparel — order online and collect at the club or get it delivered. Members get their plan discount automatically.</p>
      <div className="mb-4"><PriceNotes scopes={["PRODUCTS"]} title="Offers right now" /></div>
      <ShopCatalogue products={JSON.parse(JSON.stringify(products))} initialCategory={sp.category ?? ""} />
    </div>
  );
}
