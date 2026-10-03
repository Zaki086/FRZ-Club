import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { SalesList } from "./sales-list";

export const metadata: Metadata = { title: "Counter sales" };

export default async function ShopSalesPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Counter sales" subtitle="Every sale at the shop counter: what was sold, how it was paid and who sold it. Returns are taken from the sale." />
      <SalesList canReturn={can(actor, "shop.counter")} />
    </div>
  );
}
