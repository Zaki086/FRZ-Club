"use client";
// v3 §9.3: products with the standard FilterBar (category, brand, Active/Archived, low stock, promotion, price range).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { NewProductDialog } from "../stock/stock-table";

type Row = {
  id: string; name: string; brand: string; category: string; thumb: string | null; image_url: string | null; status: string; variants: number;
  min_price: number | null; max_price: number | null; available: number; low: boolean | null; has_promotion: boolean; track_stock: boolean;
};

/** The existing "New product" dialog (stock page), reloading this list after a create. */
function Create() {
  const reload = useListReload();
  return <NewProductDialog onDone={reload} />;
}

export function ProductsList({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  return (
    <FilteredList<Row>
      list="products"
      searchPlaceholder="Name, brand or SKU"
      toolbar={canCreate ? <Create /> : null}
      onRowClick={(r) => router.push(`/app/shop/products/${r.id}`)}
      columns={[
        { key: "photo", header: "", cell: (r) => (r.thumb ?? r.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- the club's own uploaded thumbnail
          <img src={r.thumb ?? r.image_url!} alt="" width={48} height={48} className="h-12 w-12 rounded-lg border object-cover" />
        ) : <span className="block h-12 w-12 rounded-lg border bg-secondary" aria-hidden />) },
        { key: "name", header: "Product", cell: (r) => (
          <span className="flex flex-col">
            <Link className="font-semibold text-primary hover:underline" href={`/app/shop/products/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            <span className="text-xs text-muted-foreground">{[r.brand, r.category.charAt(0) + r.category.slice(1).toLowerCase()].filter(Boolean).join(" · ")}{r.variants > 1 ? ` · ${r.variants} sizes/colours` : ""}</span>
          </span>
        ) },
        { key: "price", header: "Price", className: "text-right", cell: (r) => (r.min_price === null ? "—" : r.min_price === r.max_price ? <Money paise={r.min_price} /> : <span><Money paise={r.min_price} /> – <Money paise={r.max_price ?? r.min_price} /></span>) },
        { key: "stock", header: "Available", className: "text-right", cell: (r) => (!r.track_stock ? <span className="text-muted-foreground">service</span> : r.low ? <Badge tone="amber">{r.available} · low</Badge> : <span className="tabular">{r.available}</span>) },
        { key: "status", header: "", cell: (r) => (
          <span className="flex flex-wrap gap-1">
            {r.status === "ARCHIVED" ? <Badge tone="neutral">Archived</Badge> : null}
            {r.has_promotion ? <Badge tone="blue">Promotion</Badge> : null}
          </span>
        ) },
      ]}
      empty={{ title: "No products match these filters" }}
    />
  );
}
