import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { SalesList } from "./sales-list";
import { NewSale } from "./sales-tools";

export const metadata: Metadata = { title: "Counter sales" };

export default async function ShopSalesPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Counter sales" />
      {/* v6 WI-1: the Manager sells from Counter Sales (shop staff have the Counter POS on their menu). */}
      {can(actor, "shop.counter") && actor.role !== "SHOP_STAFF" ? <div className="mb-4"><NewSale /></div> : null}
      <SalesList canReturn={can(actor, "shop.counter")} />
    </div>
  );
}
