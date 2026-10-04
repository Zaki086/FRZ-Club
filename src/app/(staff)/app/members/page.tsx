import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/page";
import { MembersList } from "./members-list";

export default async function MembersPage() {
  const actor = await requireUser();
  if (!can(actor, "members.view")) forbidden();
  return (
    <div>
      <PageHeader title="Members" />
      {/* v5 §3.4: bulk messages from Members are the Manager's (and the Owner's). */}
      <MembersList canCreate={can(actor, "members.manage")} canBulkSend={can(actor, "messages.bulk_members")} canEditText={can(actor, "messages.templates.view")} />
    </div>
  );
}
