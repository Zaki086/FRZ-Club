"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { PageHeader } from "@/components/page";

type Run = {
  id: string; month: string; status: string; approvedAt: string | null; paidAt: string | null; method: string | null;
  totals: { gross: number; deductions: number; net: number };
  payslips: Array<{ id: string; name: string; role: string; gross: number; unpaidDays: number; deductions: number; net: number; paidAt: string | null }>;
};

export function PayrollRunView({ runId, isOwner }: { runId: string; isOwner: boolean }) {
  const state = useApi<Run>(`/api/payroll/${runId}`);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState("ONLINE");
  return (
    <div className="flex flex-col gap-3">
      <Link href="/app/finance/payroll" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="h-4 w-4" /> Payroll</Link>
      <DataState state={state}>
        {(r) => (
          <>
            <PageHeader title={`Payroll ${r.month}`} subtitle={<span className="inline-flex items-center gap-2">Status <StatusBadge status={r.status} />{r.method ? ` · paid by ${r.method.toLowerCase()}` : ""}</span>} />
            <RejectionBanner error={error} />
            <div className="flex flex-wrap items-end gap-2">
              {r.status === "DRAFT" ? (
                <Button
                  disabled={busy}
                  title={isOwner ? undefined : "Only the owner can approve payroll"}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api(`/api/payroll/${runId}/approve`, { body: {} });
                      await state.reload();
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Approve (owner)
                </Button>
              ) : null}
              {r.status === "APPROVED" ? (
                <ConfirmButton
                  trigger="Pay salaries"
                  variant="default"
                  title={`Pay payroll ${r.month}`}
                  description="Marks every payslip paid and writes PAYROLL entries to the ledger. This can't be undone."
                  confirmLabel="Pay now"
                  onConfirm={async () => {
                    await api(`/api/payroll/${runId}/pay`, { body: { method } });
                    await state.reload();
                  }}
                >
                  <p className="text-sm">Total net pay: <Money paise={r.totals.net} className="font-semibold" /></p>
                  <Field label="Method">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}><option>ONLINE</option><option>UPI</option><option>CASH</option><option>CARD</option></Select>
                  </Field>
                </ConfirmButton>
              ) : null}
            </div>
            <Card>
              <Table>
                <THead><TR><TH>Employee</TH><TH>Role</TH><TH className="text-right">Gross</TH><TH className="text-right">Unpaid days</TH><TH className="text-right">Deductions</TH><TH className="text-right">Net</TH><TH /></TR></THead>
                <TBody>
                  {r.payslips.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium">{p.name}</TD>
                      <TD className="text-xs">{p.role.replace("_", " ")}</TD>
                      <TD className="text-right"><Money paise={p.gross} /></TD>
                      <TD className="text-right">{p.unpaidDays}</TD>
                      <TD className="text-right"><Money paise={p.deductions} /></TD>
                      <TD className="text-right font-semibold"><Money paise={p.net} /></TD>
                      <TD><Link className="text-sm text-primary underline" href={`/app/finance/payroll/payslips/${p.id}`}>Payslip</Link></TD>
                    </TR>
                  ))}
                  <TR className="font-semibold">
                    <TD colSpan={2}>Totals</TD>
                    <TD className="text-right"><Money paise={r.totals.gross} /></TD>
                    <TD />
                    <TD className="text-right"><Money paise={r.totals.deductions} /></TD>
                    <TD className="text-right"><Money paise={r.totals.net} /></TD>
                    <TD />
                  </TR>
                </TBody>
              </Table>
            </Card>
          </>
        )}
      </DataState>
    </div>
  );
}
