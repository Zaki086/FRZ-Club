import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ExpiringAndDues } from "./expiring-and-dues";

export default async function ExpiringPage() {
  const actor = await requireUser();
  if (!can(actor, "members.view")) forbidden();
  return (
    <div>
      <PageHeader title="Expiring memberships & dues" subtitle="Memberships ending within 7 days (or expired in the last 14) without a renewal, and every unpaid customer bill." />
      <ExpiringAndDues />
    </div>
  );
}
