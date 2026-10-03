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
      <PageHeader title="Members" subtitle="Search by name, phone or member code. Status is computed from membership dates and payments." />
      <MembersList canCreate={can(actor, "members.manage")} />
    </div>
  );
}
