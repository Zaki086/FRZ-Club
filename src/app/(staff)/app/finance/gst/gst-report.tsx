"use client";
import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { PeriodLabel, PeriodPicker, periodQuery, periodReady, type PeriodState } from "../_components/period";
import { label } from "../_components/fmt";

type Row = { rate: number; category: string; taxable: number; tax: number; cgst: number; sgst: number; igst: number };
type Data = { period: { label: string; from: string; to: string }; ratesVerified: boolean; rows: Row[]; totals: Omit<Row, "rate" | "category">; inputGst: number; note: string };

export function GstReport() {
  const [p, setP] = useState<PeriodState>({ period: "MONTH", from: "", to: "" });
  const q = periodQuery(p);
  const state = useApi<Data>(periodReady(p) ? `/api/reports/gst?${q}` : null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodPicker value={p} onChange={setP} />
        <Button asChild variant="outline" size="sm" disabled={!periodReady(p)}>
          <a href={`/api/reports/csv?report=gst&${q}`}><Download className="h-4 w-4" /> CSV</a>
        </Button>
      </div>
      {!periodReady(p) ? <p className="text-sm text-muted-foreground">Pick both dates for a custom period.</p> : null}
      <DataState state={state}>
        {(d) => (
          <>
            <PeriodLabel period={d.period} />
            {!d.ratesVerified ? (
              <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                <AlertTriangle className="h-4 w-4" /> GST rates are seeded placeholders and have not been verified by the owner.{" "}
                <Link href="/app/settings" className="font-semibold underline">Verify rates in Settings</Link>
              </div>
            ) : null}
            <Card>
              {d.rows.length === 0 ? (
                <CardContent className="py-8 text-center text-sm text-muted-foreground">No taxable collections in this period.</CardContent>
              ) : (
                <Table>
                  <THead><TR><TH>Rate</TH><TH>Category</TH><TH className="text-right">Taxable value</TH><TH className="text-right">Tax</TH><TH className="text-right">CGST</TH><TH className="text-right">SGST</TH><TH className="text-right">IGST</TH></TR></THead>
                  <TBody>
                    {d.rows.map((r) => (
                      <TR key={`${r.rate}-${r.category}`}>
                        <TD>{r.rate}%</TD>
                        <TD>{label(r.category)}</TD>
                        <TD className="text-right"><Money paise={r.taxable} /></TD>
                        <TD className="text-right"><Money paise={r.tax} /></TD>
                        <TD className="text-right"><Money paise={r.cgst} /></TD>
                        <TD className="text-right"><Money paise={r.sgst} /></TD>
                        <TD className="text-right"><Money paise={r.igst} /></TD>
                      </TR>
                    ))}
                    <TR className="font-semibold">
                      <TD colSpan={2}>Total</TD>
                      <TD className="text-right"><Money paise={d.totals.taxable} /></TD>
                      <TD className="text-right"><Money paise={d.totals.tax} /></TD>
                      <TD className="text-right"><Money paise={d.totals.cgst} /></TD>
                      <TD className="text-right"><Money paise={d.totals.sgst} /></TD>
                      <TD className="text-right"><Money paise={d.totals.igst} /></TD>
                    </TR>
                  </TBody>
                </Table>
              )}
            </Card>
            <Card><CardContent className="pt-4 text-sm">Input GST on supplier bills paid in this period: <Money paise={d.inputGst} className="font-semibold" /></CardContent></Card>
            <p className="text-xs text-muted-foreground">{d.note}</p>
          </>
        )}
      </DataState>
    </div>
  );
}
