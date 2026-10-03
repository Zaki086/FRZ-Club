import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { PayrollRuns } from "./payroll-runs";

export default async function PayrollPage() {
  const actor = await requireUser();
  if (!can(actor, "payroll")) forbidden();
  return (
    <div>
      <PageHeader title="Payroll" subtitle="Monthly runs: draft → approved by the owner → paid. Unpaid leave days are deducted at salary ÷ days in month." />
      <PayrollRuns />
    </div>
  );
}
