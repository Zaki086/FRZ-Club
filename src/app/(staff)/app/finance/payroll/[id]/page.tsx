import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PayrollRunView } from "./payroll-run";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "payroll")) forbidden();
  const { id } = await params;
  return <PayrollRunView runId={id} isOwner={actor.role === "OWNER"} />;
}
