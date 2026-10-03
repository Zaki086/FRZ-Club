"use client";
import { Fragment, useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { MovementAmount, MovementBill, MovementDetail, MovementType, type MovementRow } from "@/components/drawer-movements";
import { fmtDateTime } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { SESSION_STATUS } from "../drawers-list";

type Stat = { count: number; amount: number };
type Session = {
  id: string; name: string; staff: string | null; status: string; openedAt: string; closedAt: string | null; openingFloat: number; balance: number;
  cashExpected: number | null; cashCounted: number | null; variance: number | null; varianceReason: string | null; floatCarried: number | null; cashDropped: number | null; dropRef: string | null;
  approvedByName: string | null; approvedAt: string | null; rejectedByName: string | null; rejectedAt: string | null; rejectionReason: string | null; note: string | null;
  summary: { openingFloat: number; sales: Stat; refunds: Stat; payIns: Stat; payOuts: Stat; drops: Stat; closingDrop: number; adjustment: number };
  card: number; upi: number; online: number;
  movements: Array<{ id: string; lineNo: number; type: string; amount: number; balanceAfter: number; at: string; atClose: boolean; reference: string | null; category: string | null; note: string | null; actor: string | null; billId: string | null; customer: string | null; source: string | null; refundCode: string | null }>;
  canDecide: boolean; canExplain: boolean;
};

const toRow = (m: Session["movements"][number]): MovementRow => ({
  id: m.id, line_no: m.lineNo, type: m.type, amount: m.amount, balance_after: m.balanceAfter, at: m.at, at_close: m.atClose, reference: m.reference,
  category: m.category, note: m.note, bill_id: m.billId, customer: m.customer, source: m.source, refund_code: m.refundCode,
});

export function DrawerSession({ id }: { id: string }) {
  const state = useApi<Session>(`/api/drawer/sessions/${id}`, { pollMs: 10_000 });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReason("");
      await state.reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <DataState state={state}>
      {(s) => (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {s.name} · {s.staff}
                <Badge tone={SESSION_STATUS[s.status]?.tone ?? "neutral"}>{SESSION_STATUS[s.status]?.label ?? s.status}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">Opened {fmtDateTime(s.openedAt)}{s.closedAt ? ` · closed ${fmtDateTime(s.closedAt)}` : ""}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-xl border p-2"><span className="text-xs text-muted-foreground">{s.closedAt ? "Left in the till" : "Cash in drawer now"}</span><br /><Money paise={s.balance} className="font-display text-xl font-bold" /></div>
                <div className="rounded-xl border p-2"><span className="text-xs text-muted-foreground">Cash sales</span><br /><Money paise={s.summary.sales.amount} className="font-semibold" /> <span className="text-xs">({s.summary.sales.count})</span></div>
                <div className="rounded-xl border p-2"><span className="text-xs text-muted-foreground">Cash refunds</span><br /><Money paise={-s.summary.refunds.amount} className="font-semibold" /> <span className="text-xs">({s.summary.refunds.count})</span></div>
                <div className="rounded-xl border p-2"><span className="text-xs text-muted-foreground">Pay-ins / pay-outs / drops</span><br /><span className="tabular">{formatINR(s.summary.payIns.amount)} / {formatINR(s.summary.payOuts.amount)} / {formatINR(s.summary.drops.amount + s.summary.closingDrop)}</span></div>
              </div>
              {s.closedAt ? (
                <div className={`grid max-w-md grid-cols-2 gap-1 rounded-xl p-3 ${s.variance ? "bg-warning/15" : "bg-success/10"}`} data-testid="session-close">
                  <span>Expected at close</span><Money paise={s.cashExpected ?? 0} className="text-right" />
                  <span>Counted</span><Money paise={s.cashCounted ?? 0} className="text-right" />
                  <span>Variance</span><Money paise={s.variance ?? 0} className="text-right font-semibold" />
                  <span>To the safe</span><span className="text-right">{formatINR(s.cashDropped ?? 0)}{s.dropRef ? ` · bag ${s.dropRef}` : ""}</span>
                  <span>Left in the till</span><Money paise={s.floatCarried ?? 0} className="text-right" />
                  {s.varianceReason ? <span className="col-span-2 text-muted-foreground">Reason: {s.varianceReason}</span> : null}
                  {s.approvedByName ? <span className="col-span-2 text-muted-foreground">Approved by {s.approvedByName} · {fmtDateTime(s.approvedAt!)}</span> : null}
                  {s.rejectedByName ? <span className="col-span-2 text-muted-foreground">Not accepted by {s.rejectedByName}: {s.rejectionReason}</span> : null}
                </div>
              ) : null}
              {s.card || s.upi || s.online ? <p className="text-xs text-muted-foreground">Collected by other methods (not in the cash): card {formatINR(s.card)} · UPI {formatINR(s.upi)} · online {formatINR(s.online)}</p> : null}
              {s.canDecide ? (
                <div className="flex flex-col gap-2 rounded-xl border p-3" data-testid="variance-decision">
                  <Field label="Reason (needed to reject)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => act(() => api(`/api/drawer/sessions/${s.id}/approve`, { body: {} }))}>Approve variance</Button>
                    <Button variant="destructive" disabled={busy} onClick={() => act(() => api(`/api/drawer/sessions/${s.id}/reject`, { body: { reason } }))}>Reject</Button>
                  </div>
                </div>
              ) : null}
              {s.canExplain && !s.varianceReason ? (
                <div className="flex flex-col gap-2 rounded-xl border p-3">
                  <Field label="Why is the count different?"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Variance reason" /></Field>
                  <Button size="sm" disabled={busy} onClick={() => act(() => api(`/api/drawer/sessions/${s.id}/reason`, { body: { reason } }))}>Send for approval</Button>
                </div>
              ) : null}
              <RejectionBanner error={error} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Movements</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <THead><TR><TH>#</TH><TH>Time</TH><TH>Type</TH><TH>Details</TH><TH>By</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance</TH></TR></THead>
                <TBody>
                  {s.movements.map((m) => {
                    const r = toRow(m);
                    return (
                      <Fragment key={m.id}>
                        <TR className={r.bill_id ? "cursor-pointer" : ""} onClick={() => r.bill_id && setExpanded(expanded === m.id ? null : m.id)}>
                          <TD className="text-xs text-muted-foreground">{m.lineNo}</TD>
                          <TD className="whitespace-nowrap text-xs">{fmtDateTime(m.at)}</TD>
                          <TD><MovementType type={m.type} /></TD>
                          <TD><MovementDetail m={r} /></TD>
                          <TD className="text-xs">{m.actor ?? "—"}</TD>
                          <TD className="text-right"><MovementAmount m={r} /></TD>
                          <TD className="text-right"><Money paise={m.balanceAfter} className="font-semibold" /></TD>
                        </TR>
                        {expanded === m.id && r.bill_id ? <tr><td colSpan={7} className="bg-secondary/30 px-4 py-2"><MovementBill billId={r.bill_id} /></td></tr> : null}
                      </Fragment>
                    );
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </DataState>
  );
}
