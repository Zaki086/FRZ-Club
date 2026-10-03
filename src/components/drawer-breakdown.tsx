"use client";
// v3 §5.1: what a drawer session collected, by method, with the payments behind each total (they add up exactly).
// Only cash is in the drawer; UPI, card and online are "collected to bank/terminal".
import { Fragment, useState } from "react";
import { useApi } from "./api";
import { Money } from "./money";
import { DataState } from "./states";
import { Table, TBody, TD, TH, THead, TR } from "./ui/table";
import { fmtDateTime } from "@/lib/time";

export type Collection = { method: string; count: number; amount: number; refundCount: number; refunded: number };
const LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", ONLINE: "Online" };
const WHERE: Record<string, string> = { CASH: "in the drawer", UPI: "to the club's bank (UPI)", CARD: "to the card terminal", ONLINE: "to the gateway account" };

type Drill = {
  total: number; refunded: number;
  payments: Array<{ id: string; amount: number; reference: string | null; at: string; customer: string; source: string }>;
  refunds: Array<{ id: string; amount: number; reference: string | null; at: string; customer: string; source: string }>;
};

function Payments({ sessionId, method }: { sessionId: string; method: string }) {
  const state = useApi<Drill>(`/api/drawer/${sessionId}/payments?method=${method}`);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-1 text-xs" data-testid={`drawer-drill-${method}`}>
          {[...d.payments.map((p) => ({ ...p, sign: 1 })), ...d.refunds.map((p) => ({ ...p, sign: -1 }))].map((p) => (
            <div key={p.id} className="flex justify-between gap-2">
              <span>{fmtDateTime(p.at)} · {p.customer} · {p.source.replace(/_/g, " ").toLowerCase()}{p.reference ? ` · ${p.reference}` : ""}{p.sign < 0 ? " · refund" : ""}</span>
              <Money paise={p.sign * p.amount} className="tabular" />
            </div>
          ))}
          <div className="flex justify-between border-t pt-1 font-semibold"><span>{d.payments.length} payment{d.payments.length === 1 ? "" : "s"}</span><Money paise={d.total} /></div>
        </div>
      )}
    </DataState>
  );
}

export function DrawerBreakdown({ sessionId, collections, total }: { sessionId: string; collections: Collection[]; total: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <THead><TR><TH>Collected</TH><TH className="text-right">Payments</TH><TH className="text-right">Amount</TH><TH className="text-right">Refunded</TH></TR></THead>
      <TBody>
        {collections.map((c) => (
          <Fragment key={c.method}>
            <TR className="cursor-pointer" onClick={() => setOpen(open === c.method ? null : c.method)} aria-expanded={open === c.method}>
              <TD><span className="font-semibold">{LABEL[c.method] ?? c.method}</span> <span className="text-xs text-muted-foreground">{WHERE[c.method]}</span></TD>
              <TD className="text-right tabular">{c.count}</TD>
              <TD className="text-right"><Money paise={c.amount} /></TD>
              <TD className="text-right">{c.refunded ? <Money paise={-c.refunded} /> : <span className="text-muted-foreground">—</span>}</TD>
            </TR>
            {open === c.method ? <tr><td colSpan={4} className="bg-secondary/30 px-4 py-2"><Payments sessionId={sessionId} method={c.method} /></td></tr> : null}
          </Fragment>
        ))}
        <TR><TD className="font-semibold">Total collected</TD><TD className="text-right tabular">{collections.reduce((a, c) => a + c.count, 0)}</TD><TD className="text-right font-bold"><Money paise={total} /></TD><TD /></TR>
      </TBody>
    </Table>
  );
}
