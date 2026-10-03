import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { PurchaseOrders } from "./purchase-orders";

export const metadata: Metadata = { title: "Purchase orders" };

export default async function PurchasingPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Purchase orders" subtitle="Order from suppliers; receiving an order puts the stock on the shelf and creates the supplier bill." />
      <PurchaseOrders canManage={can(actor, "shop.stock")} />
    </div>
  );
}
