import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { listCatalogue } from "@/server/services/shop";
import { categoryLabel } from "@/components/shop-categories";
import { ProductBuy } from "./product-buy";
import { ProductImage } from "@/components/product-image";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const product = (await listCatalogue()).find((p) => p.id === id);
  return product ? { title: product.name, description: product.description || `${product.brand} ${product.name}` } : { title: "Product not found" };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = (await listCatalogue()).find((p) => p.id === id && p.category !== "SERVICES");
  if (!product) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/shop" className="text-sm text-primary underline">← Back to the shop</Link>
      <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">{product.brand} · {categoryLabel(product.category)}</p>
      <h1 className="text-3xl font-bold">{product.name}</h1>
      <ProductImage url={product.imageUrl} category={product.category} name={product.name} className="mt-3 aspect-[4/3] w-full max-w-md" />
      {product.images.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="product-gallery">
          {product.images.map((img, i) => (
            <a key={img.url} href={img.url} target="_blank" rel="noopener">
              {/* eslint-disable-next-line @next/next/no-img-element -- the club's own uploaded photo */}
              <img src={img.thumbUrl} alt={`${product.name} photo ${i + 1}`} width={80} height={80} className="h-20 w-20 rounded-lg border object-cover" />
            </a>
          ))}
        </div>
      ) : null}
      {/* v3 §9.3: plain text with line breaks. */}
      <p className="mt-2 whitespace-pre-line text-muted-foreground">{product.description}</p>
      <ProductBuy product={JSON.parse(JSON.stringify(product))} />
    </div>
  );
}
