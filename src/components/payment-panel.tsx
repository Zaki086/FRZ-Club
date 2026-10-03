"use client";
// Staff payment panel: shows the server's bill (lines with explanations, total, paid, due) and records
// one or more counter payments (split cash/card/UPI, E-14). It never computes amounts itself — the due
// shown is the server's, and every rejection message is shown verbatim.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Plus, Trash2 } from "lucide-react";
import { formatINR, parseRupees } from "@/lib/money";
import { upiLink } from "@/lib/upi";
import { api, ApiError, newIdempotencyKey, useApi } from "./api";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
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
        <span className="text-muted-foreground">Total (incl. GST {formatINR(bill.taxTotal)})</span>
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

type Part = { method: "CASH" | "CARD" | "UPI"; amount: string; reference: string; tendered: string };

export function PaymentPanel({
  billId,
  onPaid,
  upiVpa = "championsclub@testupi",
  allowOnline = true,
  submit,
}: {
  billId: string;
  onPaid?: () => void;
  upiVpa?: string;
  allowOnline?: boolean;
  /** Custom submit (e.g. settle a bar tab atomically). Defaults to one counter payment per part. */
  submit?: (parts: Array<{ method: Part["method"]; amount: number; reference?: string; tendered?: number }>) => Promise<unknown>;
}) {
  const state = useApi<BillView>(`/api/bills/${billId}`);
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const due = state.data?.due ?? 0;
  const firstUpi = parts.find((p) => p.method === "UPI");
  const upiAmount = firstUpi ? parseRupees(firstUpi.amount) : null;

  useEffect(() => {
    if (!upiAmount || !state.data) return;
    let cancelled = false;
    QRCode.toDataURL(upiLink({ vpa: upiVpa, payee: "The Champions Club", amountPaise: upiAmount, note: `Bill ${billId.slice(-6)}` }), { width: 160, margin: 1 })
      .then((d) => {
        if (!cancelled) setQr(d);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [upiAmount, upiVpa, billId, state.data]);

  const effectiveParts: Part[] = parts.length ? parts : [{ method: "CASH", amount: due ? (due / 100).toFixed(2) : "", reference: "", tendered: "" }];

  const update = (i: number, patch: Partial<Part>) => {
    const base = parts.length ? parts : effectiveParts;
    setParts(base.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };

  return (
    <DataState state={state}>
      {(bill) => (
        <div className="flex flex-col gap-3">
          <BillLines bill={bill} />
          {bill.due > 0 ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
              <p className="text-sm font-semibold">Take payment</p>
              {effectiveParts.map((p, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <Select
                    className="col-span-3"
                    value={p.method}
                    onChange={(e) => update(i, { method: e.target.value as Part["method"] })}
                    aria-label="Method"
                  >
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="UPI">UPI</option>
                  </Select>
                  <Input className="col-span-3" inputMode="decimal" placeholder="Amount ₹" value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} aria-label="Amount" />
                  {p.method === "CASH" ? (
                    <Input className="col-span-4" inputMode="decimal" placeholder="Tendered ₹ (optional)" value={p.tendered} onChange={(e) => update(i, { tendered: e.target.value })} aria-label="Cash tendered" />
                  ) : (
                    <Input className="col-span-4" placeholder={p.method === "UPI" ? "UTR / ref" : "Card last 4"} value={p.reference} onChange={(e) => update(i, { reference: e.target.value })} aria-label="Reference" />
                  )}
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
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setParts([...effectiveParts, { method: "UPI", amount: "", reference: "", tendered: "" }])}>
                  <Plus className="h-4 w-4" /> Split payment
                </Button>
              </div>
              {qr ? (
                <div className="flex items-center gap-3 rounded-md border bg-card p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="UPI QR code" className="h-28 w-28" />
                  <p className="text-xs text-muted-foreground">Customer scans to pay {upiAmount ? formatINR(upiAmount) : ""} by UPI. Enter the UTR once received.</p>
                </div>
              ) : null}
              <RejectionBanner error={error} />
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
                        const tendered = p.tendered ? parseRupees(p.tendered) : null;
                        return { method: p.method, amount, reference: p.reference || undefined, tendered: tendered ?? undefined };
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
                {allowOnline ? (
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
                  {p.type === "REFUND" ? "Refund" : "Payment"} · {p.method} · {formatINR(p.amount)} · {p.status}
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
