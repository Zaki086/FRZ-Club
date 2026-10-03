import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { LeadDetailView } from "./lead-detail";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "crm")) forbidden();
  const { id } = await params;
  return <LeadDetailView leadId={id} canConvert={can(actor, "members.manage")} />;
}
