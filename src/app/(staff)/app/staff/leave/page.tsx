import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { LeaveApprovals } from "./leave-approvals";

export default async function LeavePage() {
  const actor = await requireUser();
  if (!can(actor, "leave.approve")) forbidden();
  return (
    <div>
      <PageHeader title="Leave approvals" subtitle="Approving leave automatically unassigns that person's shifts — they become open shifts to refill." />
      <LeaveApprovals />
    </div>
  );
}
