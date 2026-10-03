// Printable owner money summary (R-38, R-39, R-46). Pure presentation of server numbers — used by
// /app/reports and the public read-only /share/[token] page.
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/time";

type Kpi = { value: number; prev: number; change: number | null };
export type ReportData = {
  period: { label: string; from: string; to: string; prevFrom: string; prevTo: string };
  money: {
    collected?: Kpi;
    bySource?: Record<string, Kpi>;
    byMethod?: Record<string, Kpi>;
    expenses?: Kpi;
    payroll?: Kpi;
    netCashFlow?: Kpi;
  };
  receivables?: { total: number; count: number };
  payables?: { total: number; expenses: number; payroll: number; gst: number };
  generatedAt: string;
};

const SOURCE_LABEL: Record<string, string> = { COURTS: "Courts", SOCIAL: "Social play", SHOP: "Shop", BAR: "Bar & cafe", MEMBERSHIP: "Memberships", INVOICE: "Invoices" };
const METHOD_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK_TRANSFER: "Bank transfer", ONLINE: "Online" };

function change(c: number | null) {
  if (c === null) return "new";
  return `${c > 0 ? "+" : ""}${c}%`;
}

function Rows({ title, rows }: { title: string; rows: Array<{ label: string; kpi: Kpi }> }) {
  const total = rows.reduce((a, r) => a + r.kpi.value, 0);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th className="py-1">{title}</th>
          <th className="py-1 text-right">This period</th>
          <th className="py-1 text-right">Previous</th>
          <th className="py-1 text-right">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-border">
            <td className="py-1">{r.label}</td>
            <td className="tabular py-1 text-right">{formatINR(r.kpi.value)}</td>
            <td className="tabular py-1 text-right text-muted-foreground">{formatINR(r.kpi.prev)}</td>
            <td className="tabular py-1 text-right text-muted-foreground">{change(r.kpi.change)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="font-semibold">
          <td className="py-1">Total</td>
          <td className="tabular py-1 text-right">{formatINR(total)}</td>
          <td colSpan={2} />
        </tr>
      </tfoot>
    </table>
  );
}

export function ReportSummary({ data, clubName }: { data: ReportData; clubName: string }) {
  const m = data.money;
  return (
    <div className="flex flex-col gap-5 rounded-lg border bg-white p-6 text-foreground print:border-0 print:p-0">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-3">
        <div>
          <p className="text-xl font-bold">{clubName}</p>
          <p className="text-sm">Owner report · {data.period.label}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          {fmtDate(data.period.from)} – {fmtDate(data.period.to)}
          <br />
          compared with {fmtDate(data.period.prevFrom)} – {fmtDate(data.period.prevTo)}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {m.collected ? (
          <div className="rounded-md bg-secondary p-3">
            <p className="text-xs text-muted-foreground">Collected (net of refunds)</p>
            <p className="tabular text-2xl font-bold">{formatINR(m.collected.value)}</p>
            <p className="text-xs text-muted-foreground">prev {formatINR(m.collected.prev)} · {change(m.collected.change)}</p>
          </div>
        ) : null}
        {m.expenses && m.payroll ? (
          <div className="rounded-md bg-secondary p-3">
            <p className="text-xs text-muted-foreground">Paid out (expenses + payroll)</p>
            <p className="tabular text-2xl font-bold">{formatINR(m.expenses.value + m.payroll.value)}</p>
            <p className="text-xs text-muted-foreground">expenses {formatINR(m.expenses.value)} · payroll {formatINR(m.payroll.value)}</p>
          </div>
        ) : null}
        {m.netCashFlow ? (
          <div className="rounded-md bg-secondary p-3">
            <p className="text-xs text-muted-foreground">Net cash flow</p>
            <p className="tabular text-2xl font-bold">{formatINR(m.netCashFlow.value)}</p>
            <p className="text-xs text-muted-foreground">prev {formatINR(m.netCashFlow.prev)} · {change(m.netCashFlow.change)}</p>
          </div>
        ) : null}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {m.bySource ? <Rows title="By source" rows={Object.entries(m.bySource).map(([k, v]) => ({ label: SOURCE_LABEL[k] ?? k, kpi: v }))} /> : null}
        {m.byMethod ? <Rows title="By method" rows={Object.entries(m.byMethod).map(([k, v]) => ({ label: METHOD_LABEL[k] ?? k, kpi: v }))} /> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.receivables ? (
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">What we are owed (receivables, now)</p>
            <p className="tabular text-xl font-bold">{formatINR(data.receivables.total)}</p>
            <p className="text-xs text-muted-foreground">{data.receivables.count} unpaid customer bills and invoices</p>
          </div>
        ) : null}
        {data.payables ? (
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">What we owe (payables)</p>
            <p className="tabular text-xl font-bold">{formatINR(data.payables.total)}</p>
            <p className="text-xs text-muted-foreground">
              supplier bills {formatINR(data.payables.expenses)} · approved payroll {formatINR(data.payables.payroll)} · GST collected (estimate) {formatINR(data.payables.gst)}
            </p>
          </div>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        All figures are read from the club ledger. Refunds are netted against their original source. GST is an estimate for report support, not a filing.
      </p>
    </div>
  );
}
