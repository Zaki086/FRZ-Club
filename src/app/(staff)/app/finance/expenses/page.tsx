import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ExpensesList } from "./expenses-list";

export default async function ExpensesPage() {
  const actor = await requireUser();
  if (!can(actor, "expenses.view")) forbidden();
  return (
    <div>
      <PageHeader title="Expenses & payables" />
      <ExpensesList canManage={can(actor, "expenses.manage")} />
    </div>
  );
}
