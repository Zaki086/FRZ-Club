import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { AuditViewer } from "./audit-viewer";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const actor = await requireUser();
  if (!can(actor, "audit")) forbidden();
  return (
    <div>
      <PageHeader title="Audit log" />
      <AuditViewer />
    </div>
  );
}
