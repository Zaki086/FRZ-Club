import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DeskSearch } from "./desk-search";
import { DeskToday } from "./desk-today";
import { MembersList } from "../members/members-list";

export default async function DeskPage() {
  const actor = await requireUser();
  if (!can(actor, "checkin")) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Today at the desk" />
      <DeskToday />
      <DeskSearch />
      {/* v6 DESK-1: every member, with the members list's FilterBar and summary strip, below the check-in search (the
          front desk has no Members menu entry; /app/members stays theirs to not open, RN-1). A row opens the member. */}
      {can(actor, "members.view") ? (
        <section className="mt-6 flex flex-col gap-2" aria-labelledby="desk-all-members" data-testid="desk-members">
          <h2 id="desk-all-members" className="text-lg font-bold">All members</h2>
          <MembersList canCreate={false} canBulkSend={can(actor, "messages.bulk_members")} canEditText={can(actor, "messages.templates.view")} openOnRowClick />
        </section>
      ) : null}
    </div>
  );
}
