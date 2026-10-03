import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { CounterPos } from "./_components/pos";
import { TodaySales } from "./_components/today-sales";

export default async function ShopCounterPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.counter")) forbidden();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Counter POS" subtitle="Fast counter sale from the same shelf as online orders. Prices and member discounts come from the server." />
      <CounterPos />
      <TodaySales />
    </div>
  );
}
