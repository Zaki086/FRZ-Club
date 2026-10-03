import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { EmployeeDetail } from "./employee-detail";

export const metadata: Metadata = { title: "Employee" };

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "staff.directory")) forbidden();
  const { id } = await params;
  return <EmployeeDetail id={id} />;
}
