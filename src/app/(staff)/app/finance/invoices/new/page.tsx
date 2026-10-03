import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { NewInvoiceForm } from "./new-invoice-form";

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ clientId?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "invoices")) forbidden();
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="New invoice" subtitle="Creates a draft. Taxes, totals and the CGST/SGST/IGST split are computed by the server." />
      <NewInvoiceForm initialClientId={sp.clientId ?? ""} />
    </div>
  );
}
