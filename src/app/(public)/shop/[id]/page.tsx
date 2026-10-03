import { notFound } from "next/navigation";
import Link from "next/link";
import { listCatalogue } from "@/server/services/shop";
import { categoryLabel } from "@/components/shop-categories";
import { ProductBuy } from "./product-buy";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = (await listCatalogue()).find((p) => p.id === id && p.category !== "SERVICES");
  if (!product) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/shop" className="text-sm text-primary underline">← Back to the shop</Link>
      <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">{product.brand} · {categoryLabel(product.category)}</p>
      <h1 className="text-3xl font-bold">{product.name}</h1>
      <p className="mt-2 text-muted-foreground">{product.description}</p>
      <ProductBuy product={JSON.parse(JSON.stringify(product))} />
    </div>
  );
}
