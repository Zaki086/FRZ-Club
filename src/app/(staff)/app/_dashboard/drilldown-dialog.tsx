"use client";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

type Drill = {
  total: number;
  kind: "money" | "count";
  period: { label: string; from: string; to: string };
  rows: Array<{ id: string; at: string; source: string; method: string | null; description: string; amount: number; billId: string | null }>;
};

/** DB-3: every number clicks through to the records whose sum equals it. */
export function DrillDownDialog({
  metric,
  title,
  query,
  onClose,
}: {
  metric: string | null;
  title: string;
  query: string;
  onClose: () => void;
}) {
  const url = metric ? `/api/reports/drilldown?metric=${encodeURIComponent(metric)}&${query}` : null;
  const state = useApi<Drill>(url);
  return (
    <Dialog open={!!metric} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      {metric ? (
        <DialogContent title={title}  wide>
          <DataState state={state} isEmpty={(d) => d.rows.length === 0} empty={{ title: "No records in this period" }}>
            {(d) => {
              const sum = d.rows.reduce((a, r) => a + r.amount, 0);
              const ok = sum === d.total;
              const fmt = (n: number) => (d.kind === "money" ? formatINR(n) : n.toLocaleString("en-IN"));
              return (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">
                    {d.period.label}: {d.period.from} → {d.period.to} · {d.rows.length} record{d.rows.length === 1 ? "" : "s"}
                  </p>
                  <div className="max-h-[55vh] overflow-y-auto rounded-md border">
                    <Table>
                      <THead>
                        <TR>
                          <TH>When</TH>
                          <TH>Source</TH>
                          <TH>Method</TH>
                          <TH>Description</TH>
                          <TH className="text-right">{d.kind === "money" ? "Amount" : "Count"}</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {d.rows.map((r) => (
                          <TR key={r.id}>
                            <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</TD>
                            <TD className="text-xs">{r.source}</TD>
                            <TD className="text-xs">{r.method ?? "—"}</TD>
                            <TD className="text-xs">{r.description}</TD>
                            <TD className={`tabular text-right ${r.amount < 0 ? "text-destructive" : ""}`}>{fmt(r.amount)}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/60 p-3 text-sm">
                    <div className="flex flex-col">
                      <span>
                        Server total: <strong className="tabular" data-testid="drill-total">{fmt(d.total)}</strong>
                      </span>
                      <span className={`inline-flex items-center gap-1 ${ok ? "text-success-text" : "text-destructive"}`}>
                        {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                        Sum of rows: <span className="tabular">{fmt(sum)}</span> {ok ? "— matches" : "— MISMATCH"}
                      </span>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/reports/csv?report=drilldown&metric=${encodeURIComponent(metric)}&${query}`}>
                        <Download className="h-4 w-4" /> CSV
                      </a>
                    </Button>
                  </div>
                </div>
              );
            }}
          </DataState>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
