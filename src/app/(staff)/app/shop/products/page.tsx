import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ProductsList } from "./products-list";
import { ShopDiscounts } from "./shop-discounts";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Products" subtitle="Everything the shop sells: photos, sizes, prices and discounts. Stock changes only through receipts, stock takes and adjustments." />
      <ProductsList canCreate={can(actor, "shop.stock")} />
      <ShopDiscounts />
    </div>
  );
}
