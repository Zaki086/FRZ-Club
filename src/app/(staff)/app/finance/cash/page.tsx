import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { CashReconciliation } from "./cash-reconciliation";

export default async function CashPage() {
  const actor = await requireUser();
  if (!can(actor, "cash.reconcile")) forbidden();
  return (
    <div>
      <PageHeader title="Daily cash reconciliation" subtitle="Every drawer opened that day: float, cash expected, counted, variance, card and UPI totals, and the bank deposit." />
      <CashReconciliation />
    </div>
  );
}
