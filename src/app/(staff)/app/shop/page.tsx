import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { TODO_HOME } from "@/server/services/todo";
import { TodoPanel } from "../_components/todo-panel";
import { CounterPos } from "./_components/pos";
import { TodaySales } from "./_components/today-sales";

export default async function ShopCounterPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.counter")) forbidden();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Counter POS" />
      {TODO_HOME[actor.role] === "shop" ? <TodoPanel /> : null}
      <CounterPos />
      <TodaySales />
    </div>
  );
}
