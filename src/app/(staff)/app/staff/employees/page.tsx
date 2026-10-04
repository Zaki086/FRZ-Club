import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { EmployeesList } from "./employees-list";

export const metadata: Metadata = { title: "Staff directory" };

export default async function EmployeesPage() {
  const actor = await requireUser();
  if (!can(actor, "staff.directory")) forbidden();
  return (
    <div>
      <PageHeader title="Staff" />
      <EmployeesList />
    </div>
  );
}
