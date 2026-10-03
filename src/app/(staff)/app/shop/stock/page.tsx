import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { StockTable } from "./stock-table";

export default async function StockPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  const sp = await searchParams;
  return (
    <div>
      <PageHeader title="Stock & receipts" subtitle="One shelf for counter and online. Every change is a stock movement; available = on hand − reserved." />
      <StockTable lowOnly={sp.filter === "low"} perms={{ stock: can(actor, "shop.stock"), price: can(actor, "dashboard.ops") }} />
    </div>
  );
}
