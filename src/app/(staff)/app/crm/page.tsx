import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { LeadsBoard } from "./leads-board";

export default async function CrmPage() {
  const actor = await requireUser();
  if (!can(actor, "crm")) forbidden();
  return (
    <div>
      <PageHeader title="Leads" subtitle="Every enquiry, trial and walk-in until it is won or lost. Overdue follow-ups are red." />
      <LeadsBoard />
    </div>
  );
}
