"use client";
// v4 §3.4 Payments tab: every payment and refund on the member's (and their Juniors') bills, newest first, with the
// running totals after each one and a link to the receipt, invoice or refund receipt.
import Link from "next/link";
import { useApi } from "@/components/api";
import { Money } from "@/components/money";
import { DataState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/time";

type Row = {
  id: string; at: string; type: "PAYMENT" | "REFUND"; method: string; amount: number; status: string; what: string; forName: string | null;
  refundCode: string | null; receipt: string; runningPaid: number; runningRefunded: number; runningNet: number;
};
type Data = { rows: Row[]; totals: { paid: number; refunded: number; net: number } };

export function MyPaymentsView() {
  const state = useApi<Data>("/api/portal/payments");
  return (
    <DataState state={state} isEmpty={(d) => d.rows.length === 0} empty={{ title: "No payments yet", hint: "Payments and refunds on your bookings, orders, tabs and membership appear here." }}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold">My payments</h1>
          <div className="grid grid-cols-3 gap-2" data-testid="payments-totals">
            <Card className="min-w-0"><CardContent className="px-3 pt-4 pb-3 sm:px-5"><p className="text-xs text-muted-foreground">Paid</p><p className="text-base font-bold [overflow-wrap:anywhere] sm:text-xl"><Money paise={d.totals.paid} /></p></CardContent></Card>
            <Card className="min-w-0"><CardContent className="px-3 pt-4 pb-3 sm:px-5"><p className="text-xs text-muted-foreground">Refunded</p><p className="text-base font-bold [overflow-wrap:anywhere] sm:text-xl"><Money paise={d.totals.refunded} /></p></CardContent></Card>
            <Card className="min-w-0"><CardContent className="px-3 pt-4 pb-3 sm:px-5"><p className="text-xs text-muted-foreground">Net</p><p className="text-base font-bold [overflow-wrap:anywhere] sm:text-xl"><Money paise={d.totals.net} /></p></CardContent></Card>
          </div>
          <Table>
            <THead>
              <TR><TH>Date</TH><TH>For</TH><TH>How</TH><TH className="text-right">Amount</TH><TH className="text-right">Net so far</TH><TH /></TR>
            </THead>
            <TBody>
              {d.rows.map((r) => (
                <TR key={r.id} data-testid="payment-row">
                  <TD className="whitespace-nowrap text-sm">{fmtDateTime(r.at)}</TD>
                  <TD className="text-sm">
                    {r.what}{r.forName ? <span className="text-muted-foreground"> · {r.forName}</span> : null}
                    {r.refundCode ? <span className="block font-mono text-xs text-muted-foreground">{r.refundCode}</span> : null}
                  </TD>
                  <TD className="text-sm">
                    {r.type === "REFUND" ? <Badge tone={r.status === "PENDING" ? "blue" : "green"}>{r.status === "PENDING" ? "Refund waiting at the desk" : "Refund"}</Badge> : <Badge tone="neutral">Payment</Badge>}{" "}
                    {r.method}
                  </TD>
                  <TD className="text-right"><Money paise={r.type === "REFUND" ? -r.amount : r.amount} className="font-semibold" /></TD>
                  <TD className="text-right"><Money paise={r.runningNet} /></TD>
                  <TD className="text-right"><Link className="text-sm font-semibold text-primary underline" href={r.receipt}>{r.receipt.includes("/invoices/") ? "Invoice" : "Receipt"}</Link></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </DataState>
  );
}
