import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { TODO_HOME } from "@/server/services/todo";
import { TodoPanel } from "../_components/todo-panel";
import { ClockInBanner } from "./_components/clock-in-banner";
import { TablesMap } from "./tables-map";
import { IncomingOrders } from "./incoming-orders";

export default async function BarPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.operate")) forbidden();
  return (
    <div>
      <PageHeader title="Bar & cafeteria" />
      <ClockInBanner />
      {TODO_HOME[actor.role] === "bar" ? <TodoPanel /> : null}
      <IncomingOrders />
      <TablesMap />
    </div>
  );
}
