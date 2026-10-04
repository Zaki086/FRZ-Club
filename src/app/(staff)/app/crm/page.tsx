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
      <PageHeader title="Leads" />
      <LeadsBoard
        canBulkSend={can(actor, "messages.bulk")}
        canEditText={can(actor, "messages.templates.view")}
        canReopen={can(actor, "leads.reopen")}
        canConvert={can(actor, "members.manage")}
      />
    </div>
  );
}
