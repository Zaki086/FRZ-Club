"use client";
// v4 §2.6 daily cash reconciliation: every line reconciles or shows its difference in red with a link — ledger cash vs
// drawer movements, refunds, drops and pay-ins vs the safe, variances, handovers, deposits — then every drawer session.
import Link from "next/link";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/money";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";

type Row = {
  id: string; name: string; role: string | null; area: string; drawerName: string; status: string; openedAt: string; closedAt: string | null; open: boolean;
  openingFloat: number; cashExpected: number | null; cashCounted: number | null; variance: number | null; cardTotal: number | null; upiTotal: number | null;
  floatCarried: number | null; cashDropped: number | null; depositAmount: number | null; depositRef: string | null;
};
type Line = { key: string; label: string; expected: number; actual: number; difference: number; ok: boolean; href: string | null; detail: string };
type Rec = {
  date: string; sessions: Row[]; lines: Line[];
  safe: { start: number; end: number; now: number };
  deposits: Array<{ id: string; amount: number; slipRef: string; source: string }>;
  totals: { expected: number; counted: number; variance: number; card: number; upi: number; deposited: number; openDrawers: number; unreconciled: number };
};

/** v3: a drawer closed before the safe was kept is deposited straight from its count. */
function LegacyDeposit({ row, onDone }: { row: Row; onDone: () => void }) {
  const [amount, setAmount] = useState(row.cashCounted ? (row.cashCounted / 100).toFixed(2) : "");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <Input className="h-8 w-24" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Deposit amount" />
        <Input className="h-8 w-28" placeholder="Bank ref" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Deposit reference" />
        <Button size="sm" onClick={async () => {
          setError(null);
          try {
            await api(`/api/finance/cash/${row.id}/deposit`, { body: { amount: parseRupees(amount) ?? 0, reference: ref } });
            onDone();
          } catch (e) {
            setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
          }
        }}>Save</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function CashReconciliation() {
  const [date, setDate] = useState("");
  const state = useApi<Rec>(`/api/finance/cash${date ? `?date=${date}` : ""}`);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input type="date" className="w-44" value={date || state.data?.date || ""} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
      </div>
      <DataState state={state}>
        {(r) => (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-xl border p-2">Cash expected at close<br /><Money paise={r.totals.expected} className="font-semibold" /></div>
              <div className="rounded-xl border p-2">Counted<br /><Money paise={r.totals.counted} className="font-semibold" /></div>
              <div className={`rounded-xl border p-2 ${r.totals.variance ? "border-warning/50 bg-warning/15" : ""}`}>Variance<br /><Money paise={r.totals.variance} className="font-semibold" /></div>
              <div className="rounded-xl border p-2">Safe: start → end of day<br /><span className="font-semibold tabular">{formatINR(r.safe.start)} → {formatINR(r.safe.end)}</span></div>
              <div className="rounded-xl border p-2">Banked that day<br /><Money paise={r.totals.deposited} className="font-semibold" /></div>
              <div className="rounded-xl border p-2">Card<br /><Money paise={r.totals.card} /></div>
              <div className="rounded-xl border p-2">UPI<br /><Money paise={r.totals.upi} /></div>
              <div className="rounded-xl border p-2">Drawers still open<br /><span className="font-semibold">{r.totals.openDrawers}</span></div>
            </div>

            <section className="flex flex-col gap-1" data-testid="reconciliation-lines">
              <h2 className="font-display text-lg font-bold">
                Reconciliation {r.totals.unreconciled ? <Badge tone="red">{r.totals.unreconciled} to look at</Badge> : <Badge tone="green">all lines reconcile</Badge>}
              </h2>
              <Table>
                <THead><TR><TH>Check</TH><TH className="text-right">Should be</TH><TH className="text-right">Is</TH><TH className="text-right">Difference</TH><TH /></TR></THead>
                <TBody>
                  {r.lines.map((l) => (
                    <TR key={l.key} data-testid={`rec-${l.key}`} data-ok={l.ok ? "yes" : "no"}>
                      <TD><span className="font-medium">{l.label}</span><span className="block text-xs text-muted-foreground">{l.detail}</span></TD>
                      <TD className="text-right"><Money paise={l.expected} /></TD>
                      <TD className="text-right"><Money paise={l.actual} /></TD>
                      <TD className={`text-right font-semibold ${l.ok ? "text-success-text" : "text-destructive"}`}>{l.difference === 0 ? "✓ 0" : formatINR(l.difference)}{l.ok && l.difference !== 0 ? " (accepted)" : ""}</TD>
                      <TD>{l.href ? <Link href={l.href} className="text-xs text-primary underline-offset-2 hover:underline">Open</Link> : null}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </section>

            {r.sessions.length === 0 ? (
              <Empty title="No drawers that day" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead><TR><TH>Staff</TH><TH>Till</TH><TH>Open → close</TH><TH>Float</TH><TH>Expected</TH><TH>Counted</TH><TH>Variance</TH><TH>To safe / left</TH><TH>Card</TH><TH>UPI</TH><TH>Deposit</TH></TR></THead>
                  <TBody>
                    {r.sessions.map((s) => (
                      <TR key={s.id}>
                        <TD className="font-medium"><Link href={`/app/finance/drawers/${s.id}`} className="hover:underline">{s.name}</Link></TD>
                        <TD>{s.drawerName}</TD>
                        <TD className="text-xs">{fmtDateTime(s.openedAt)} → {s.closedAt ? fmtDateTime(s.closedAt) : "open"}</TD>
                        <TD><Money paise={s.openingFloat} /></TD>
                        <TD><Money paise={s.cashExpected ?? 0} /></TD>
                        <TD>{s.cashCounted === null ? "—" : <Money paise={s.cashCounted} />}</TD>
                        <TD className={s.variance ? "font-semibold text-destructive" : ""}>{s.variance === null ? "—" : <Money paise={s.variance} />}{s.status === "PENDING_APPROVAL" ? <span className="block text-xs">awaiting approval</span> : null}</TD>
                        <TD className="text-xs">{s.cashDropped === null ? "—" : `${formatINR(s.cashDropped)} / ${formatINR(s.floatCarried ?? 0)}`}</TD>
                        <TD><Money paise={s.cardTotal ?? 0} /></TD>
                        <TD><Money paise={s.upiTotal ?? 0} /></TD>
                        <TD>
                          {s.depositAmount !== null
                            ? <span className="text-xs"><Money paise={s.depositAmount} /> · {s.depositRef}</span>
                            : s.open ? "—" : s.cashDropped === null ? <LegacyDeposit row={s} onDone={() => void state.reload()} /> : <Link href="/app/finance/drawers" className="text-xs text-primary hover:underline">from the safe</Link>}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </>
        )}
      </DataState>
    </div>
  );
}
