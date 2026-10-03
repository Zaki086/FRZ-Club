import { InvoiceDocument } from "@/components/invoice-document";

export default async function PortalInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDocument invoiceId={id} />;
}
