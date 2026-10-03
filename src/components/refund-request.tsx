"use client";
// v3 RF-1/RF-2/RF-6: staff ask for a refund on a bill — amount (partial allowed, at most what is refundable), a reason
// category and a note. It goes to the refunds queue for approval; nothing is paid out here.
// v4 RF-11: a bill can have several (partial) refunds; what is still refundable is always shown next to the button.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, newIdempotencyKey, useApi } from "./api";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { RejectionBanner } from "./states";
import { formatINR, parseRupees } from "@/lib/money";

export const REFUND_REASON_OPTIONS = [
  { value: "SERVICE_ISSUE", label: "Service issue" },
  { value: "DUPLICATE_CHARGE", label: "Duplicate or over-payment" },
  { value: "PRODUCT_RETURN", label: "Product return" },
  { value: "POLICY_CANCELLATION", label: "Cancellation within policy" },
  { value: "CLUB_CANCELLATION", label: "Cancelled by the club" },
  { value: "GOODWILL", label: "Goodwill" },
  { value: "OTHER", label: "Other" },
] as const;

export function RefundRequestForm({ billId, refundable, onDone }: { billId: string; refundable: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((refundable / 100).toFixed(2));
  const [reason, setReason] = useState<string>("SERVICE_ISSUE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [sent, setSent] = useState<{ code: string; amount: number } | null>(null);
  const [key] = useState(newIdempotencyKey);
  if (sent) {
    return (
      <p className="rounded-lg bg-success/10 p-3 text-sm text-success-text" data-testid="refund-requested">
        Refund {sent.code} for {formatINR(sent.amount)} sent for approval. Follow it in <Link className="font-semibold underline" href="/app/refunds">Refunds</Link>.
      </p>
    );
  }
  if (refundable <= 0) return null; // nothing left to ask for (the confirmation above stays once sent)
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Request a refund</Button>
        <span className="text-xs text-muted-foreground" data-testid="refundable-left">{formatINR(refundable)} still refundable on this bill</span>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const paise = parseRupees(amount);
        if (!paise) return setError({ message: "Enter the amount to refund." });
        setBusy(true);
        try {
          const r = await api<{ code: string; amount: number }>("/api/refunds/request", { body: { billId, amount: paise, reason, note }, idempotencyKey: key });
          setSent(r);
          onDone();
        } catch (err) {
          setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm font-semibold">Request a refund <span className="font-normal text-muted-foreground">· up to {formatINR(refundable)}</span></p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {REFUND_REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={300} placeholder="What happened" /></Field>
      <RejectionBanner error={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Sending…" : "Send for approval"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

type BillRefundState = { id: string; refundable: number; canRequestRefund: boolean; openRefunds: Array<{ id: string; code: string; amount: number; status: string }> };

/** For a paid bill shown without the payment panel: open refunds on it and the request form. */
export function BillRefundRequest({ billId }: { billId: string }) {
  const state = useApi<BillRefundState>(`/api/bills/${billId}`);
  const b = state.data;
  if (!b || !b.canRequestRefund) return null;
  return (
    <div className="flex flex-col gap-2">
      {b.openRefunds.length ? (
        <p className="text-xs text-muted-foreground">{b.openRefunds.map((r) => `${r.code} ${formatINR(r.amount)} ${r.status === "REQUESTED" ? "awaiting approval" : "ready to collect at the desk"}`).join(" · ")}</p>
      ) : null}
      <RefundRequestForm billId={b.id} refundable={b.refundable} onDone={() => void state.reload()} />
    </div>
  );
}
