"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";

type Run = { id: string; month: string; status: string; paidAt: string | null; employees: number; net: number };

function currentMonth() {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.toISOString().slice(0, 7);
}

export function PayrollRuns() {
  const router = useRouter();
  const state = useApi<Run[]>("/api/payroll");
  const [month, setMonth] = useState(currentMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 pt-4">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Month
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
          </label>
          <Button
            disabled={busy || !/^\d{4}-\d{2}$/.test(month)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ id: string }>("/api/payroll", { body: { month } });
                router.push(`/app/finance/payroll/${r.id}`);
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                setBusy(false);
              }
            }}
          >
            Create payroll run
          </Button>
          <div className="w-full"><RejectionBanner error={error} /></div>
        </CardContent>
      </Card>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No payroll runs yet", hint: "Create the run for a month to calculate payslips." }}>
          {(rows) => (
            <Table>
              <THead><TR><TH>Month</TH><TH>Employees</TH><TH className="text-right">Net pay</TH><TH>Status</TH><TH>Paid</TH></TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD><Link className="font-medium text-primary hover:underline" href={`/app/finance/payroll/${r.id}`}>{r.month}</Link></TD>
                    <TD>{r.employees}</TD>
                    <TD className="text-right"><Money paise={r.net} /></TD>
                    <TD><StatusBadge status={r.status} /></TD>
                    <TD className="text-sm">{r.paidAt ? new Date(r.paidAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
    </div>
  );
}
