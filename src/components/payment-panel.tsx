"use client";
// Staff payment panel: shows the server's bill (lines with explanations, total, paid, due) and records
// one or more counter payments (split cash/card/UPI, E-14). It never computes amounts itself — the due
// shown is the server's, and every rejection message is shown verbatim.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { formatINR, parseRupees } from "@/lib/money";
import { api, ApiError, newIdempotencyKey, useApi } from "./api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { METHOD_LABEL, useCapabilities } from "./capabilities";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, UpiQr, useTenderMethods, type TenderDraft, type TenderMethod } from "./tender-fields";
import { DataState, RejectionBanner } from "./states";
import { Money } from "./money";
import { StatusBadge } from "./badges";

export type BillView = {
  id: string;
  customerName: string;
  tier: string;
  total: number;
  taxTotal: number;
  discountTotal: number;
  amountPaid: number;
  amountRefunded: number;
  status: string;
  due: number;
  lines: Array<{ id: string; description: string; qty: number; unitPrice: number; discountAmount: number; netAmount: number; taxAmount: number; explanation: string; voidedAt: string | null }>;
  payments: Array<{ id: string; type: string; method: string; amount: number; status: string; reference: string | null; occurredAt: string; changeGiven: number | null }>;
};

export function BillLines({ bill }: { bill: BillView }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y rounded-md border">
        {bill.lines.map((l) => (
          <div key={l.id} className={`flex items-start justify-between gap-3 p-2 text-sm ${l.voidedAt ? "opacity-50 line-through" : ""}`}>
            <div>
              <p className="font-medium">
                {l.qty > 1 ? `${l.qty} × ` : ""}
                {l.description}
              </p>
              <p className="text-xs text-muted-foreground">{l.explanation}</p>
            </div>
            <div className="text-right">
              <Money paise={l.netAmount} className="font-medium" />
              {l.discountAmount ? <p className="text-xs text-green-700">−{formatINR(l.discountAmount)} discount</p> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 text-sm">
        <span className="text-muted-foreground">{bill.taxTotal ? <>Total (incl. GST {formatINR(bill.taxTotal)})</> : "Total"}</span>
        <Money paise={bill.total} className="text-right font-semibold" />
        <span className="text-muted-foreground">Paid</span>
        <Money paise={bill.amountPaid - bill.amountRefunded} className="text-right" />
        <span className="font-semibold">Due</span>
        <Money paise={bill.due} className="text-right text-lg font-bold" />
      </div>
      <div className="flex items-center gap-2 text-sm">
        Status: <StatusBadge status={bill.status} />
      </div>
    </div>
  );
}

type SubmitPart = { method: TenderMethod; amount: number; reference?: string; tendered?: number; cardLast4?: string; approvalCode?: string };

export function PaymentPanel({
  billId,
  onPaid,
  allowOnline = true,
  bankTransfer = false,
  submit,
}: {
  billId: string;
  onPaid?: () => void;
  allowOnline?: boolean;
  /** Invoices only: also offer a bank transfer (with its reference). */
  bankTransfer?: boolean;
  /** Custom submit (e.g. settle a bar tab atomically). Defaults to one counter payment per part. */
  submit?: (parts: SubmitPart[]) => Promise<unknown>;
}) {
  const state = useApi<BillView>(`/api/bills/${billId}`);
  const caps = useCapabilities();
  const methods = useTenderMethods({ bankTransfer });
  const [parts, setParts] = useState<TenderDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const due = state.data?.due ?? 0;
  const firstUpi = parts.find((p) => p.method === "UPI");
  const upiAmount = firstUpi ? parseRupees(firstUpi.amount) : null;

  const effectiveParts: TenderDraft[] = parts.length ? parts : [emptyTender("CASH", due ? (due / 100).toFixed(2) : "")];

  const update = (i: number, patch: Partial<TenderDraft>) => {
    const base = parts.length ? parts : effectiveParts;
    setParts(base.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };

  return (
    <DataState state={state}>
      {(bill) => (
        <div className="flex flex-col gap-3">
          <BillLines bill={bill} />
          {bill.due > 0 && methods ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
              <p className="text-sm font-semibold">Take payment</p>
              {effectiveParts.map((p, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <MethodSelect className="col-span-12 sm:col-span-3" methods={methods} value={p.method} onChange={(m) => update(i, { method: m })} />
                  <Input className="col-span-5 sm:col-span-3" inputMode="decimal" placeholder="Amount ₹" value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} aria-label="Amount" />
                  <ProofFields className="col-span-5 sm:col-span-4" value={p} onChange={(patch) => update(i, patch)} />
                  <Button
                    className="col-span-2"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove part"
                    disabled={effectiveParts.length === 1}
                    onClick={() => setParts(effectiveParts.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {methods.length > 1 ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setParts([...effectiveParts, emptyTender(methods.find((m) => m !== "CASH") ?? "CASH")])}>
                    <Plus className="h-4 w-4" /> Split payment
                  </Button>
                </div>
              ) : null}
              <UpiQr amountPaise={upiAmount} note={`Bill ${billId.slice(-6)}`} />
              {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="lg"
                  disabled={busy}
                  data-testid="record-payment"
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const parsed = effectiveParts.map((p) => {
                        const amount = parseRupees(p.amount);
                        if (!amount) throw new ApiError("VALIDATION_FAILED", "Enter an amount for every payment part.", 422, null);
                        return { ...tenderProof(p), amount } as SubmitPart;
                      });
                      if (submit) await submit(parsed);
                      else for (const p of parsed) await api("/api/payments/counter", { body: { billId, ...p }, idempotencyKey: newIdempotencyKey() });
                      setParts([]);
                      await state.reload();
                      onPaid?.();
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                      await state.reload();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Recording…" : "Record payment"}
                </Button>
                {allowOnline && caps?.online ? (
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={busy}
                    onClick={async () => {
                      setError(null);
                      try {
                        const r = await api<{ redirectUrl: string }>("/api/payments/online/start", {
                          body: { billId, returnUrl: window.location.pathname + window.location.search },
                          idempotencyKey: newIdempotencyKey(),
                        });
                        window.location.href = r.redirectUrl;
                      } catch (e) {
                        setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                      }
                    }}
                  >
                    Online payment link
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {bill.payments.length ? (
            <div className="text-xs text-muted-foreground">
              {bill.payments.map((p) => (
                <p key={p.id}>
                  {p.type === "REFUND" ? "Refund" : "Payment"} · {METHOD_LABEL[p.method] ?? p.method} · {formatINR(p.amount)} · {p.status === "PENDING" && p.type === "REFUND" ? "to be paid out at the desk" : p.status}
                  {p.reference ? ` · ${p.reference}` : ""}
                  {p.changeGiven ? ` · change ${formatINR(p.changeGiven)}` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </DataState>
  );
}
