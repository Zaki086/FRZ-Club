import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { InvoicesList } from "./invoices-list";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ clientId?: string; status?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "invoices")) forbidden();
  const sp = await searchParams;
  return (
    <div>
      <PageHeader title="Invoices" subtitle="Membership tax invoices are issued automatically on payment. Business and member invoices start as drafts." />
      <InvoicesList clientId={sp.clientId ?? ""} initialStatus={sp.status ?? ""} />
    </div>
  );
}
