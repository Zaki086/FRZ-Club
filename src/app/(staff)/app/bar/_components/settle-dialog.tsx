"use client";
// BR-8 / E-14: settle with one or more payments (split). The server computes change and the remaining due.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError, newIdempotencyKey } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, UpiQr, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { formatINR, parseRupees } from "@/lib/money";
import { toRejection, type Rejection } from "./err";

type Part = TenderDraft;
type Result = { status: string; total: number; paid: number; due: number; changeGiven: number };

/** v6 JR-1: `noSplit` — a Junior's / under-18's tab is paid in one go (one method, the whole amount due). */
export function SettleDialog({ tabId, tabCode, due, noSplit = false, onDone }: { tabId: string; tabCode: string; due: number; noSplit?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const methods = useTenderMethods() ?? ["CASH"];

  const rows: Part[] = parts.length ? (noSplit ? parts.slice(0, 1) : parts) : [emptyTender("CASH", (due / 100).toFixed(2))];
  const upi = rows.find((p) => p.method === "UPI");
  const upiAmount = upi ? parseRupees(upi.amount) : null;

  const update = (i: number, patch: Partial<Part>) => setParts(rows.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setParts([]); setError(null); setResult(null); setKey(newIdempotencyKey()); onDone(); } }}>
      <DialogTrigger asChild>
        <Button size="xl" disabled={due <= 0} data-testid="settle-open">Settle {formatINR(due)}</Button>
      </DialogTrigger>
      <DialogContent title={`Settle tab ${tabCode}`} description={`Due now: ${formatINR(due)}.${!noSplit && methods.length > 1 ? " Split across methods if needed." : ""}`} wide>
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
                <MethodSelect className="col-span-12 h-12 sm:col-span-3" methods={methods} value={p.method} onChange={(m) => update(i, { method: m })} />
                <Input className="col-span-5 h-12 text-base sm:col-span-3" inputMode="decimal" placeholder="Amount ₹" value={p.amount} readOnly={noSplit} onChange={(e) => update(i, { amount: e.target.value })} aria-label="Amount" />
                <ProofFields className="col-span-6 sm:col-span-5" value={p} onChange={(patch) => update(i, patch)} />
                <Button className="col-span-1 h-12" variant="ghost" size="icon" aria-label="Remove" disabled={rows.length === 1} onClick={() => setParts(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {methods.length > 1 && !noSplit ? (
              <Button variant="outline" onClick={() => setParts([...rows, emptyTender(methods.find((m) => m !== "CASH") ?? "CASH")])}>
                <Plus className="h-4 w-4" /> Split payment
              </Button>
            ) : null}
            <UpiQr amountPaise={upiAmount} note={`Tab ${tabCode}`} />
            {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener defaultArea="BAR" onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
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
                  if (p.tendered && !parseRupees(p.tendered)) return setError({ code: "VALIDATION_FAILED", message: "Cash tendered is not a valid amount." });
                  try {
                    payments.push({ ...tenderProof(p), amount });
                  } catch (e) {
                    return setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                  }
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
