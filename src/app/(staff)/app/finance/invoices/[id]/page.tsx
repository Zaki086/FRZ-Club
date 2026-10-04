import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { InvoiceActions } from "./invoice-actions";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "invoices")) forbidden();
  const { id } = await params;
  return <InvoiceActions invoiceId={id} canMessage={can(actor, "messages.compose")} />;
}
