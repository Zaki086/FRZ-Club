"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { fmtDateTime } from "@/lib/time";
import { PeriodLabel, PeriodPicker, periodQuery, periodReady, type PeriodState } from "../_components/period";

type Entry = { id: string; occurredAt: string; source: string; direction: string; method: string; description: string; amount: number; taxAmount: number };
type Data = { period: { label: string; from: string; to: string }; rows: Entry[]; total: number };

const SOURCES = ["COURTS", "SOCIAL", "SHOP", "BAR", "MEMBERSHIP", "INVOICE", "EXPENSE", "PAYROLL"];
const METHODS = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "ONLINE"];

export function LedgerExplorer() {
  const [p, setP] = useState<PeriodState>({ period: "TODAY", from: "", to: "" });
  const [source, setSource] = useState("");
  const [method, setMethod] = useState("");
  const q = `${periodQuery(p)}${source ? `&source=${source}` : ""}${method ? `&method=${method}` : ""}`;
  const state = useApi<Data>(periodReady(p) ? `/api/reports/ledger?${q}` : null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={p} onChange={setP} />
        <Select className="w-40" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">All sources</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select className="w-36" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
          <option value="">All methods</option>{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={`/api/reports/csv?report=ledger&${q}`}><Download className="h-4 w-4" /> CSV</a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/reports/csv?report=tally&${q}`}><Download className="h-4 w-4" /> Tally day book</a>
        </Button>
      </div>
      <DataState state={state} isEmpty={(d) => d.rows.length === 0} empty={{ title: "No ledger entries", hint: "Try a longer period or remove a filter." }}>
        {(d) => (
          <>
            <div className="flex items-center justify-between">
              <PeriodLabel period={d.period} />
              <p className="text-sm">{d.rows.length} entries · net <Money paise={d.total} className="font-semibold" /></p>
            </div>
            <Card>
              <Table>
                <THead><TR><TH>When (IST)</TH><TH>Source</TH><TH>Dir.</TH><TH>Method</TH><TH>Description</TH><TH className="text-right">Amount</TH><TH className="text-right">Tax</TH></TR></THead>
                <TBody>
                  {d.rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.occurredAt)}</TD>
                      <TD><Badge tone="neutral">{r.source}</Badge></TD>
                      <TD><Badge tone={r.direction === "IN" ? "green" : "red"}>{r.direction}</Badge></TD>
                      <TD className="text-xs">{r.method}</TD>
                      <TD className="text-sm">{r.description}</TD>
                      <TD className="text-right"><Money paise={r.amount} /></TD>
                      <TD className="text-right text-xs"><Money paise={r.taxAmount} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          </>
        )}
      </DataState>
    </div>
  );
}
