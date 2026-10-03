import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { StaffActivity } from "./staff-activity";

export const metadata: Metadata = { title: "Staff activity" };

export default async function StaffActivityPage() {
  const actor = await requireUser();
  if (!can(actor, "staff.activity")) forbidden();
  return (
    <div>
      <PageHeader title="Staff activity" subtitle="Everything staff did on a day, from the audit trail." />
      <StaffActivity />
    </div>
  );
}
