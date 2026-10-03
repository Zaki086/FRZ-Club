import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { TODO_HOME } from "@/server/services/todo";
import { TodoPanel } from "../_components/todo-panel";
import { ClockInBanner } from "./_components/clock-in-banner";
import { TablesMap } from "./tables-map";

export default async function BarPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.operate")) forbidden();
  return (
    <div>
      <PageHeader title="Bar & cafeteria" subtitle="Tables and open tabs. Tap a tab to order, send to the kitchen and settle." />
      <ClockInBanner />
      {TODO_HOME[actor.role] === "bar" ? <TodoPanel /> : null}
      <TablesMap />
    </div>
  );
}
