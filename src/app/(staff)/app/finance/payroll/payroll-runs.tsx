"use client";
// v3 §3.2: payroll runs with the standard FilterBar — status, year, month — and a summary strip. Creating a run stays
// in the toolbar; each row says what happens next (the owner approves, then the accountant pays).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList } from "@/components/list/filtered-list";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";

type Row = {
  id: string; month: string; status: string; employees: number; gross: number; deductions: number; net: number; unpaid_days: number;
  approved_at: string | null; approved_by_name: string | null; paid_at: string | null; method: string | null;
};

function currentMonth() {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.toISOString().slice(0, 7);
}

function CreateRun() {
  const router = useRouter();
  const [month, setMonth] = useState(currentMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-end gap-2">
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
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

function NextStep({ r }: { r: Row }) {
  if (r.status === "DRAFT") return <Link className="text-sm font-semibold text-primary hover:underline" href={`/app/finance/payroll/${r.id}`}>Review · owner approves</Link>;
  if (r.status === "APPROVED") return <Link className="text-sm font-semibold text-primary hover:underline" href={`/app/finance/payroll/${r.id}`}>Pay <Money paise={r.net} /></Link>;
  return <span className="text-xs text-muted-foreground">Done</span>;
}

export function PayrollRuns() {
  return (
    <FilteredList<Row>
      list="payroll"
      searchPlaceholder="Month (YYYY-MM)"
      toolbar={<CreateRun />}
      columns={[
        { key: "month", header: "Month", cell: (r) => <Link className="font-medium text-primary hover:underline" href={`/app/finance/payroll/${r.id}`}>{r.month}</Link> },
        { key: "employees", header: "Employees", cell: (r) => r.employees },
        { key: "gross", header: "Gross", className: "text-right", cell: (r) => <Money paise={r.gross} /> },
        { key: "deductions", header: "Deductions", className: "text-right", cell: (r) => <Money paise={r.deductions} /> },
        { key: "net", header: "Net pay", className: "text-right", cell: (r) => <Money paise={r.net} /> },
        { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
        { key: "paid", header: "Paid", cell: (r) => (r.paid_at ? <span className="text-sm"><RelTime when={r.paid_at} />{r.method ? ` · ${r.method.replace(/_/g, " ").toLowerCase()}` : ""}</span> : <span className="text-sm">—</span>) },
        { key: "next", header: "Next", cell: (r) => <NextStep r={r} /> },
      ]}
      empty={{ title: "No payroll runs match these filters", hint: "Create the run for a month to calculate payslips." }}
    />
  );
}
