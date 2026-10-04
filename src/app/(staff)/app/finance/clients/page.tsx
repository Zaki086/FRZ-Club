import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ClientsList } from "./clients-list";

export default async function ClientsPage() {
  const actor = await requireUser();
  if (!can(actor, "invoices")) forbidden();
  return (
    <div>
      <PageHeader title="Business clients" />
      <ClientsList />
    </div>
  );
}
