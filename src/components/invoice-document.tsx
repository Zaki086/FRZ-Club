"use client";
// IN-5: printable tax invoice (print CSS → PDF) with club GSTIN, HSN/SAC per line and the CGST/SGST/IGST split.
import { Printer } from "lucide-react";
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { useApi } from "./api";
import { DataState } from "./states";
import { Button } from "./ui/button";
import { StatusBadge } from "./badges";

type Line = { id: string; description: string; hsnSac: string; qty: number; unitPrice: number; discountAmount: number; netAmount: number; taxRate: number; taxable: number; cgst: number; sgst: number; igst: number };
type Data = {
  invoice: { id: string; number: string | null; status: string; kind: string; issueDate: string | null; dueDate: string | null; placeOfSupply: string; notes: string };
  club: { name: string; legal_name: string; address: string; gstin: string; state: string; state_code: string; phone: string; email: string };
  taxRatesVerified: boolean;
  client: { name: string; gstin: string | null; address: string; stateCode: string; contactName: string } | null;
  member: { name: string; memberCode: string; phone: string; email: string | null } | null;
  bill: { total: number; amountPaid: number; amountRefunded: number; due: number };
  lines: Line[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; total: number };
  overdue: boolean;
};

export function InvoiceDocument({ invoiceId }: { invoiceId: string }) {
  const state = useApi<Data>(`/api/invoices/${invoiceId}`);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="mx-auto max-w-4xl">
          <div className="no-print mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={d.overdue ? "OVERDUE" : d.invoice.status} />
              {!d.taxRatesVerified ? <span className="text-xs text-amber-700">Tax rates not yet verified by the owner</span> : null}
            </div>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print / Save as PDF
            </Button>
          </div>
          <div className="rounded-lg border bg-white p-6 text-sm text-slate-900 print:border-0 print:p-0">
            <div className="flex flex-wrap justify-between gap-4 border-b pb-4">
              <div>
                <p className="text-xl font-bold">{d.club.name}</p>
                <p>{d.club.legal_name}</p>
                <p className="max-w-xs">{d.club.address}</p>
                <p>GSTIN: <strong>{d.club.gstin}</strong> · State: {d.club.state} ({d.club.state_code})</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold">{d.invoice.number ? "TAX INVOICE" : "DRAFT INVOICE"}</p>
                <p>No. <strong>{d.invoice.number ?? "— (draft)"}</strong></p>
                {d.invoice.issueDate ? <p>Date: {fmtDate(d.invoice.issueDate.slice(0, 10))}</p> : null}
                {d.invoice.dueDate ? <p>Due: {fmtDate(d.invoice.dueDate.slice(0, 10))}</p> : null}
                <p>Place of supply: {d.invoice.placeOfSupply}</p>
              </div>
            </div>
            <div className="border-b py-3">
              <p className="text-xs uppercase text-slate-500">Bill to</p>
              {d.client ? (
                <>
                  <p className="font-semibold">{d.client.name}</p>
                  <p>{d.client.address}</p>
                  <p>{d.client.gstin ? `GSTIN: ${d.client.gstin}` : "Unregistered (B2C)"} · Attn: {d.client.contactName}</p>
                </>
              ) : d.member ? (
                <>
                  <p className="font-semibold">{d.member.name} ({d.member.memberCode})</p>
                  <p>{d.member.phone}{d.member.email ? ` · ${d.member.email}` : ""}</p>
                </>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <table className="mt-3 w-full text-xs">
                <thead className="border-b text-left">
                  <tr>
                    <th className="py-1">Description</th><th>HSN/SAC</th><th className="text-right">Qty</th><th className="text-right">Rate</th>
                    <th className="text-right">Taxable</th><th className="text-right">GST %</th><th className="text-right">CGST</th>
                    <th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l) => (
                    <tr key={l.id} className="border-b">
                      <td className="py-1">{l.description}{l.discountAmount ? <span className="block text-slate-500">less {formatINR(l.discountAmount)}</span> : null}</td>
                      <td>{l.hsnSac}</td><td className="text-right">{l.qty}</td><td className="text-right">{formatINR(l.unitPrice)}</td>
                      <td className="text-right">{formatINR(l.taxable)}</td><td className="text-right">{l.taxRate}%</td>
                      <td className="text-right">{formatINR(l.cgst)}</td><td className="text-right">{formatINR(l.sgst)}</td>
                      <td className="text-right">{formatINR(l.igst)}</td><td className="text-right">{formatINR(l.netAmount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="font-semibold">
                  <tr>
                    <td className="py-1" colSpan={4}>Totals</td>
                    <td className="text-right">{formatINR(d.totals.taxable)}</td><td />
                    <td className="text-right">{formatINR(d.totals.cgst)}</td><td className="text-right">{formatINR(d.totals.sgst)}</td>
                    <td className="text-right">{formatINR(d.totals.igst)}</td><td className="text-right">{formatINR(d.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mt-3 flex justify-end">
              <div className="w-64 text-sm">
                <p className="flex justify-between"><span>Invoice total (GST incl.)</span><strong>{formatINR(d.bill.total)}</strong></p>
                <p className="flex justify-between"><span>Paid</span><span>{formatINR(d.bill.amountPaid - d.bill.amountRefunded)}</span></p>
                <p className="flex justify-between border-t pt-1"><span>Balance due</span><strong>{formatINR(d.bill.due)}</strong></p>
              </div>
            </div>
            {d.invoice.notes ? <p className="mt-3 text-xs">Notes: {d.invoice.notes}</p> : null}
            <p className="mt-4 text-[11px] text-slate-500">Prices are GST-inclusive; tax is extracted per line. Intra-state supplies show CGST + SGST; inter-state supplies show IGST.</p>
          </div>
        </div>
      )}
    </DataState>
  );
}
