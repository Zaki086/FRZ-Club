import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { StockTable } from "./stock-table";

export default async function StockPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Stock & receipts" />
      <StockTable perms={{ stock: can(actor, "shop.stock"), price: can(actor, "dashboard.ops") }} />
    </div>
  );
}
