import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ExpensesList } from "./expenses-list";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "expenses.view")) forbidden();
  const sp = await searchParams;
  return (
    <div>
      <PageHeader title="Expenses & payables" subtitle="Supplier bills and running costs. Paying one writes an EXPENSE entry to the ledger." />
      <ExpensesList canManage={can(actor, "expenses.manage")} initialStatus={sp.status ?? ""} />
    </div>
  );
}
