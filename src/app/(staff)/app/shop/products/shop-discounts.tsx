"use client";
// D-79: category-wide and shop-wide discounts on shop products, next to the product list. Per-product discounts are on
// each product's page; the manager's price book lists all of them.
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DiscountForm, DiscountList, type DiscountView } from "./_components/discounts";

type Data = { canEdit: boolean; staffLimitPct: number; discounts: DiscountView[] };

export function ShopDiscounts() {
  const state = useApi<Data>("/api/shop/discounts");
  const reload = () => void state.reload();
  return (
    <Card className="mt-4" data-testid="shop-discounts">
      <CardHeader><CardTitle>Shop discounts</CardTitle></CardHeader>
      <CardContent>
        <DataState state={state}>
          {(d) => (
            <div className="flex flex-col gap-3">
              <DiscountList discounts={d.discounts} canEnd={d.canEdit} onDone={reload} empty="No category or shop-wide discount right now." />
              {d.canEdit ? <DiscountForm endpoint="/api/shop/discounts" withCategories staffLimitPct={d.staffLimitPct} onDone={reload} /> : null}
            </div>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
