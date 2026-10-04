import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { TODO_HOME } from "@/server/services/todo";
import { TodoPanel } from "../../_components/todo-panel";
import { CashReconciliation } from "./cash-reconciliation";

export default async function CashPage() {
  const actor = await requireUser();
  if (!can(actor, "cash.reconcile")) forbidden();
  return (
    <div>
      <PageHeader title="Daily cash reconciliation" />
      {TODO_HOME[actor.role] === "finance" ? <TodoPanel /> : null}
      <CashReconciliation />
    </div>
  );
}
