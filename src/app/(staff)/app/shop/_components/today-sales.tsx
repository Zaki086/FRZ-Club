"use client";
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { formatINR } from "@/lib/money";

export type Sale = {
  id: string;
  code: string;
  at: string;
  customer: string;
  total: number;
  discount: number;
  status: string;
  billId: string;
  methods: string[];
  lines: Array<{ id: string; description: string; qty: number; netAmount: number; variantId: string | null }>;
};

export function ReturnDialog({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const returnable = sale.lines.filter((l) => l.variantId);
  const [open, setOpen] = useState(false);
  const [lineId, setLineId] = useState(returnable[0]?.id ?? "");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<"" | "CASH" | "CARD" | "UPI">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  if (!returnable.length) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setError(null); setDone(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Undo2 className="h-4 w-4" /> Return</Button>
      </DialogTrigger>
      <DialogContent title={`Return from ${sale.code}`}>
        {done !== null ? (
          <div className="flex flex-col gap-3">
            <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">Return recorded — {formatINR(done)} refunded.</p>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Item">
              <Select value={lineId} onChange={(e) => setLineId(e.target.value)}>
                {returnable.map((l) => (
                  <option key={l.id} value={l.id}>{l.qty} × {l.description} ({formatINR(l.netAmount)})</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Quantity returned"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label="Refund method">
                <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  <option value="">Same as paid</option>
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="UPI">UPI</option>
                </Select>
              </Field>
            </div>
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong size" /></Field>
            <RejectionBanner error={error} />
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await api<{ refunded: number }>("/api/shop/returns", {
                    body: { billId: sale.billId, lines: [{ billLineId: lineId, qty: Number(qty) }], method: method || undefined, reason },
                  });
                  setDone(r.refunded);
                  onDone();
                } catch (e) {
                  setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm return
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TodaySales() {
  const state = useApi<Sale[]>("/api/shop/counter-sales", { pollMs: 30000 });
  return (
    <Card>
      <CardHeader><CardTitle>Today&apos;s counter sales</CardTitle></CardHeader>
      <CardContent>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No counter sales yet today" }}>
          {(rows) => (
            <Table>
              <THead><TR><TH>Code</TH><TH>Time</TH><TH>Customer</TH><TH>Items</TH><TH>Paid by</TH><TH className="text-right">Total</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {rows.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-mono text-xs">{s.code}</TD>
                    <TD className="text-sm">{s.at.split(", ")[1] ?? s.at}</TD>
                    <TD>{s.customer}</TD>
                    <TD className="text-sm">{s.lines.map((l) => `${l.qty}× ${l.description}`).join(", ")}</TD>
                    <TD className="text-sm">{s.methods.join(" + ")}</TD>
                    <TD className="text-right"><Money paise={s.total} />{s.discount ? <span className="block text-xs text-green-700">−{formatINR(s.discount)}</span> : null}</TD>
                    <TD><StatusBadge status={s.status} /></TD>
                    <TD><ReturnDialog sale={s} onDone={() => void state.reload()} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
