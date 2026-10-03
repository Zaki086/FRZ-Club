import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MovementsList } from "./movements-list";

export const metadata: Metadata = { title: "Stock movements" };

export default async function StockMovementsPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Stock movements" subtitle="Every change to the shelf: goods received, sold, reserved for online orders, handed over, adjusted and returned." />
      <MovementsList />
    </div>
  );
}
