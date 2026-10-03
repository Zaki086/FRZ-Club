"use client";
// BR-8 / E-14: settle with one or more payments (split). The server computes change and the remaining due.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Plus, Trash2 } from "lucide-react";
import { api, newIdempotencyKey } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { formatINR, parseRupees } from "@/lib/money";
import { upiLink } from "@/lib/upi";
import { toRejection, type Rejection } from "./err";

type Part = { method: "CASH" | "CARD" | "UPI"; amount: string; reference: string; tendered: string };
type Result = { status: string; total: number; paid: number; due: number; changeGiven: number };

export function SettleDialog({ tabId, tabCode, due, onDone }: { tabId: string; tabCode: string; due: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);

  const rows: Part[] = parts.length ? parts : [{ method: "CASH", amount: (due / 100).toFixed(2), reference: "", tendered: "" }];
  const upi = rows.find((p) => p.method === "UPI");
  const upiAmount = upi ? parseRupees(upi.amount) : null;

  useEffect(() => {
    if (!open || !upiAmount) return;
    let cancelled = false;
    QRCode.toDataURL(upiLink({ vpa: "championsclub@testupi", payee: "The Champions Club", amountPaise: upiAmount, note: `Tab ${tabCode}` }), { width: 150, margin: 1 })
      .then((d) => { if (!cancelled) setQr(d); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [open, upiAmount, tabCode]);

  const update = (i: number, patch: Partial<Part>) => setParts(rows.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setParts([]); setError(null); setResult(null); setKey(newIdempotencyKey()); onDone(); } }}>
      <DialogTrigger asChild>
        <Button size="xl" disabled={due <= 0} data-testid="settle-open">Settle {formatINR(due)}</Button>
      </DialogTrigger>
      <DialogContent title={`Settle tab ${tabCode}`} description={`Due now: ${formatINR(due)}. Split across cash, card and UPI if needed.`} wide>
        {result ? (
          <div className="flex flex-col gap-3">
            {result.changeGiven > 0 ? (
              <div className="rounded-lg border-2 border-green-500 bg-green-50 p-4 text-center">
                <p className="text-sm text-green-800">Give change</p>
                <p className="text-4xl font-black text-green-800">{formatINR(result.changeGiven)}</p>
              </div>
            ) : null}
            {result.status === "SETTLED" ? (
              <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm font-medium">Tab settled — {formatINR(result.paid)} paid in total.</p>
            ) : (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">Partly paid. {formatINR(result.due)} is still due; the tab stays {result.status.toLowerCase()}.</p>
            )}
            <Button size="lg" onClick={() => setOpen(false)}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((p, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Select className="col-span-3 h-12" value={p.method} onChange={(e) => update(i, { method: e.target.value as Part["method"] })} aria-label="Method">
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="UPI">UPI</option>
                </Select>
                <Input className="col-span-3 h-12 text-base" inputMode="decimal" placeholder="Amount ₹" value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} aria-label="Amount" />
                {p.method === "CASH" ? (
                  <Input className="col-span-5 h-12 text-base" inputMode="decimal" placeholder="Cash tendered ₹" value={p.tendered} onChange={(e) => update(i, { tendered: e.target.value })} aria-label="Cash tendered" />
                ) : (
                  <Input className="col-span-5 h-12 text-base" placeholder={p.method === "UPI" ? "UTR / reference" : "Card last 4"} value={p.reference} onChange={(e) => update(i, { reference: e.target.value })} aria-label="Reference" />
                )}
                <Button className="col-span-1 h-12" variant="ghost" size="icon" aria-label="Remove" disabled={rows.length === 1} onClick={() => setParts(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" onClick={() => setParts([...rows, { method: "UPI", amount: "", reference: "", tendered: "" }])}>
              <Plus className="h-4 w-4" /> Split payment
            </Button>
            {qr && upiAmount ? (
              <div className="flex items-center gap-3 rounded-md border p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="UPI QR code" className="h-28 w-28" />
                <p className="text-xs text-muted-foreground">Customer scans to pay {formatINR(upiAmount)} by UPI. Enter the UTR once received.</p>
              </div>
            ) : null}
            <RejectionBanner error={error} />
            <Button
              size="xl"
              disabled={busy}
              data-testid="settle-submit"
              onClick={async () => {
                setError(null);
                const payments = [];
                for (const p of rows) {
                  const amount = parseRupees(p.amount);
                  if (!amount) return setError({ code: "VALIDATION_FAILED", message: "Enter an amount for every payment part." });
                  const tendered = p.tendered ? parseRupees(p.tendered) : null;
                  if (p.tendered && !tendered) return setError({ code: "VALIDATION_FAILED", message: "Cash tendered is not a valid amount." });
                  payments.push({ method: p.method, amount, reference: p.reference || undefined, tendered: tendered ?? undefined });
                }
                setBusy(true);
                try {
                  setResult(await api<Result>(`/api/bar/tabs/${tabId}/settle`, { body: { payments }, idempotencyKey: key }));
                } catch (e) {
                  setError(toRejection(e));
                  setKey(newIdempotencyKey());
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Recording…" : "Take payment"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
