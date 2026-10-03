"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmButton } from "@/components/confirm";
import { InvoiceDocument } from "@/components/invoice-document";
import { PaymentPanel } from "@/components/payment-panel";
import { WhatsAppButton } from "@/components/whatsapp-button";

type Data = { invoice: { id: string; status: string; kind: string; billId: string; number: string | null }; bill: { due: number } };

export function InvoiceActions({ invoiceId }: { invoiceId: string }) {
  const state = useApi<Data>(`/api/invoices/${invoiceId}`);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void state.reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="no-print">
        <Link href="/app/finance/invoices" className="inline-flex items-center gap-1 text-sm text-primary">
          <ArrowLeft className="h-4 w-4" /> Invoices
        </Link>
      </div>
      <DataState state={state}>
        {(d) => (
          <div className="no-print flex flex-col gap-3">
            <RejectionBanner error={error} />
            <div className="flex flex-wrap gap-2">
              {d.invoice.status !== "DRAFT" && d.invoice.status !== "CANCELLED" ? <WhatsAppButton target={{ template: "INVOICE", invoiceId }} /> : null}
              {d.invoice.status === "DRAFT" ? (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api(`/api/invoices/${invoiceId}`, { body: { action: "issue" } });
                      refresh();
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Issue invoice
                </Button>
              ) : null}
              {d.invoice.status !== "CANCELLED" && d.invoice.status !== "PAID" ? (
                <ConfirmButton
                  trigger="Cancel invoice"
                  title="Cancel invoice"
                  description="Issued invoices are cancelled, never deleted. Any amount paid must be refunded first."
                  requireReason
                  confirmLabel="Cancel invoice"
                  onConfirm={async (reason) => {
                    await api(`/api/invoices/${invoiceId}`, { body: { action: "cancel", reason } });
                    refresh();
                  }}
                />
              ) : null}
            </div>
            {d.invoice.status !== "DRAFT" && d.invoice.status !== "CANCELLED" && d.bill.due > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Record payment</CardTitle>
                </CardHeader>
                <CardContent>
                  <PaymentPanel key={version} billId={d.invoice.billId} allowOnline={false} bankTransfer onPaid={refresh} />
                </CardContent>
              </Card>
            ) : null}
          </div>
        )}
      </DataState>
      <InvoiceDocument key={version} invoiceId={invoiceId} />
    </div>
  );
}
