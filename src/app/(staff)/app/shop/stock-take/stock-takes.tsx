"use client";
// v3 §3.2: the count sheet, then every stock take posted so far (with the standard FilterBar).
import { useState } from "react";
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StockTakeSheet } from "./stock-take-sheet";

type Row = {
  id: string; code: string; note: string | null; posted_at: string; created_by_name: string | null; counted: number; changed: number; short: number; surplus: number;
  status: "ADJUSTED" | "MATCHED"; lines: Array<{ id: string; sku: string; name: string; expected: number; counted: number; delta: number }>;
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function StockTakes() {
  // Posting a count remounts the list so the new stock take shows straight away.
  const [version, setVersion] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <StockTakeSheet onPosted={() => setVersion((v) => v + 1)} />
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-bold">Stock takes</h2>
        <FilteredList<Row>
          key={version}
          list="stock-takes"
          searchPlaceholder="STK-000123, note or who counted"
          columns={[
            { key: "code", header: "Stock take", cell: (t) => (
              <span className="flex flex-col">
                <span className="font-mono text-sm font-semibold">{t.code}</span>
                <RelTime when={t.posted_at} className="text-xs text-muted-foreground" />
              </span>
            ) },
            { key: "by", header: "Counted by", cell: (t) => <span className="text-sm">{t.created_by_name ?? "—"}</span> },
            { key: "counted", header: "Items counted", className: "text-right", cell: (t) => <span className="tabular">{t.counted}</span> },
            { key: "changed", header: "Adjusted", className: "text-right", cell: (t) => <span className="tabular">{t.changed}</span> },
            { key: "units", header: "Units short / over", className: "text-right", cell: (t) => <span className="tabular">{t.short ? `−${t.short}` : "0"} / {t.surplus ? `+${t.surplus}` : "0"}</span> },
            { key: "status", header: "Result", cell: (t) => <Badge tone={t.status === "ADJUSTED" ? "amber" : "green"}>{t.status === "ADJUSTED" ? "Differences posted" : "All matched"}</Badge> },
          ]}
          rowExtra={(t) => (
            <div className="flex flex-col gap-2 text-sm">
              {t.note ? <p>{t.note}</p> : null}
              <Table>
                <THead><TR><TH>Item</TH><TH>SKU</TH><TH className="text-right">Expected</TH><TH className="text-right">Counted</TH><TH className="text-right">Difference</TH></TR></THead>
                <TBody>
                  {t.lines.map((l) => (
                    <TR key={l.id}>
                      <TD>{l.name}</TD>
                      <TD className="font-mono text-xs">{l.sku}</TD>
                      <TD className="text-right tabular">{l.expected}</TD>
                      <TD className="text-right tabular">{l.counted}</TD>
                      <TD className={`text-right tabular ${l.delta ? "font-semibold text-amber-700" : ""}`}>{l.delta ? signed(l.delta) : "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          empty={{ title: "No stock takes match these filters", hint: "Count the shelf above and post it." }}
        />
      </section>
    </div>
  );
}
