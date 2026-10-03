"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/money";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/time";
import { parseRupees } from "@/lib/money";

type Row = {
  id: string; name: string; role: string | null; area: string; openedAt: string; closedAt: string | null; open: boolean;
  openingFloat: number; cashExpected: number | null; cashCounted: number | null; variance: number | null; cardTotal: number | null; upiTotal: number | null;
  depositAmount: number | null; depositRef: string | null;
};
type Rec = { date: string; sessions: Row[]; totals: { expected: number; counted: number; variance: number; card: number; upi: number; deposited: number; openDrawers: number } };

function Deposit({ row, onDone }: { row: Row; onDone: () => void }) {
  const [amount, setAmount] = useState(row.cashCounted ? (row.cashCounted / 100).toFixed(2) : "");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <Input className="h-8 w-24" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Deposit amount" />
        <Input className="h-8 w-28" placeholder="Bank ref" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Deposit reference" />
        <Button
          size="sm"
          onClick={async () => {
            setError(null);
            try {
              await api(`/api/finance/cash/${row.id}/deposit`, { body: { amount: parseRupees(amount) ?? 0, reference: ref } });
              onDone();
            } catch (e) {
              setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
            }
          }}
        >
          Save
        </Button>
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
              <div className="rounded-md border p-2">Cash expected<br /><Money paise={r.totals.expected} className="font-semibold" /></div>
              <div className="rounded-md border p-2">Counted<br /><Money paise={r.totals.counted} className="font-semibold" /></div>
              <div className={`rounded-md border p-2 ${r.totals.variance ? "border-amber-300 bg-amber-50" : ""}`}>Variance<br /><Money paise={r.totals.variance} className="font-semibold" /></div>
              <div className="rounded-md border p-2">Deposited<br /><Money paise={r.totals.deposited} className="font-semibold" /></div>
              <div className="rounded-md border p-2">Card<br /><Money paise={r.totals.card} /></div>
              <div className="rounded-md border p-2">UPI<br /><Money paise={r.totals.upi} /></div>
              <div className="rounded-md border p-2">Drawers still open<br /><span className="font-semibold">{r.totals.openDrawers}</span></div>
            </div>
            {r.sessions.length === 0 ? (
              <Empty title="No drawers that day" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead><TR><TH>Staff</TH><TH>Drawer</TH><TH>Open → close</TH><TH>Float</TH><TH>Expected</TH><TH>Counted</TH><TH>Variance</TH><TH>Card</TH><TH>UPI</TH><TH>Deposit</TH></TR></THead>
                  <TBody>
                    {r.sessions.map((s) => (
                      <TR key={s.id}>
                        <TD className="font-medium">{s.name}</TD>
                        <TD>{s.area}</TD>
                        <TD className="text-xs">{fmtDateTime(s.openedAt)} → {s.closedAt ? fmtDateTime(s.closedAt) : "open"}</TD>
                        <TD><Money paise={s.openingFloat} /></TD>
                        <TD><Money paise={s.cashExpected ?? 0} /></TD>
                        <TD>{s.cashCounted === null ? "—" : <Money paise={s.cashCounted} />}</TD>
                        <TD className={s.variance ? "font-semibold text-amber-700" : ""}>{s.variance === null ? "—" : <Money paise={s.variance} />}</TD>
                        <TD><Money paise={s.cardTotal ?? 0} /></TD>
                        <TD><Money paise={s.upiTotal ?? 0} /></TD>
                        <TD>{s.depositAmount !== null ? <span className="text-xs"><Money paise={s.depositAmount} /> · {s.depositRef}</span> : s.open ? "—" : <Deposit row={s} onDone={() => void state.reload()} />}</TD>
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
