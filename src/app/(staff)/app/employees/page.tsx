import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { EmployeesAdmin } from "./employees-admin";

export const metadata: Metadata = { title: "Employees" };

/** v4 §1.2 Employees (Owner): staff accounts and HR details. The live "who is in" view is the Staff Directory. */
export default async function EmployeesAdminPage() {
  const actor = await requireUser();
  if (!can(actor, "users.manage")) forbidden();
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Employees" />
      <EmployeesAdmin selfUserId={actor.userId} />
    </div>
  );
}
