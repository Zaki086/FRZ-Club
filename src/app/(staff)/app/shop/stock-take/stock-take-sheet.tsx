"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

type Row = { variantId: string; sku: string; product: string; label: string; onHand: number; reserved: number; trackStock: boolean };
type Result = { code: string; changed: number; lines: Array<{ variantId: string; expected: number; counted: number; delta: number }> };

export function StockTakeSheet() {
  const stock = useApi<Row[]>("/api/shop/stock");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  return (
    <DataState state={stock}>
      {(rows) => {
        const tracked = rows.filter((r) => r.trackStock);
        const lines = tracked.filter((r) => counts[r.variantId] !== undefined && counts[r.variantId] !== "").map((r) => ({ variantId: r.variantId, counted: Number(counts[r.variantId]) }));
        return (
          <div className="flex flex-col gap-3">
            {result ? <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm" data-testid="stock-take-result">Stock take {result.code} posted: {result.lines.length} counted, {result.changed} adjusted.</p> : null}
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>Item</TH><TH>SKU</TH><TH className="text-right">System</TH><TH className="text-right">Reserved</TH><TH className="text-right">Counted</TH><TH className="text-right">Difference</TH></TR></THead>
                <TBody>
                  {tracked.map((r) => {
                    const c = counts[r.variantId];
                    const diff = c !== undefined && c !== "" && /^\d+$/.test(c) ? Number(c) - r.onHand : null;
                    return (
                      <TR key={r.variantId}>
                        <TD>{r.product}{r.label !== "Standard" ? ` · ${r.label}` : ""}</TD>
                        <TD className="font-mono text-xs">{r.sku}</TD>
                        <TD className="text-right tabular">{r.onHand}</TD>
                        <TD className="text-right tabular">{r.reserved}</TD>
                        <TD className="text-right"><Input className="ml-auto h-8 w-20 text-right" inputMode="numeric" value={c ?? ""} onChange={(e) => setCounts({ ...counts, [r.variantId]: e.target.value.replace(/\D/g, "") })} aria-label={`Counted ${r.sku}`} /></TD>
                        <TD className={`text-right tabular ${diff ? "font-semibold text-amber-700" : ""}`}>{diff === null ? "" : diff > 0 ? `+${diff}` : diff}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <RejectionBanner error={error} />
            <Button
              className="self-start"
              disabled={busy || lines.length === 0}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await api<Result>("/api/shop/stock-takes", { body: { lines } }));
                  setCounts({});
                  await stock.reload();
                } catch (e) {
                  setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Post stock take ({lines.length} counted)
            </Button>
          </div>
        );
      }}
    </DataState>
  );
}
