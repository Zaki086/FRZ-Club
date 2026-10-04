"use client";
// v4 §3.4: the member's Refunds tab — every refund (their own and their Juniors') with the timeline Requested →
// Approved → Ready to collect → Collected, amount, reason, what it was for, dates, who approved, how and where it was
// paid out, the receipt once collected, the collection QR while it waits, and "Request refund" on eligible items with
// what is left to refund on each (RF-11).
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FileText, QrCode } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Money } from "@/components/money";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Timeline, type TimelineStep } from "@/components/refund-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { formatINR, parseRupees } from "@/lib/money";
import { RefundQrButton } from "../_components/refund-qr";

export type MyRefund = {
  id: string; code: string; amount: number; status: string; collectStatus: string | null; reason: string; note: string | null; what: string; billSource: string;
  forName: string | null; requestedAt: string; requestedVia: string; decidedAt: string | null; approvedBy: string | null; autoApproved: boolean;
  decisionNote: string | null; readyAt: string | null; completedAt: string | null; toCollect: number;
  paidOut: Array<{ method: string; amount: number; at: string; where: string | null }>; token: string | null;
};
export type MyRefunds = {
  refunds: MyRefund[];
  eligible: Array<{ billId: string; what: string; refundable: number; paid: number; reason: string; forName: string | null }>;
  ready: { count: number; amount: number };
};

function label(r: MyRefund): { text: string; tone: "amber" | "blue" | "green" | "red" | "neutral" } {
  if (r.status === "REQUESTED") return { text: "Waiting for approval", tone: "amber" };
  if (r.status === "APPROVED" && r.collectStatus === "READY_TO_COLLECT") return { text: "Ready to collect", tone: "blue" };
  if (r.status === "APPROVED") return { text: "Approved", tone: "blue" };
  if (r.status === "COMPLETED") return { text: r.collectStatus === "COLLECTED" ? "Collected" : "Refunded", tone: "green" };
  if (r.status === "REJECTED") return { text: "Not approved", tone: "red" };
  if (r.status === "CANCELLED") return { text: "Withdrawn", tone: "neutral" };
  return { text: "Being sorted at the desk", tone: "neutral" };
}

function steps(r: MyRefund): TimelineStep[] {
  const stopped = ["REJECTED", "CANCELLED", "FAILED"].includes(r.status);
  return [
    { label: "Requested", at: r.requestedAt, detail: r.requestedVia === "MEMBER" ? "by you" : r.requestedVia === "STAFF" ? "by the club" : "automatically", state: "done" },
    stopped
      ? { label: r.status === "REJECTED" ? "Not approved" : r.status === "CANCELLED" ? "Withdrawn" : "Being sorted", at: r.decidedAt, detail: r.decisionNote, state: "stopped" }
      : { label: "Approved", at: r.decidedAt, detail: r.autoApproved ? "by club policy" : r.approvedBy ? `by ${r.approvedBy}` : null, state: r.status === "REQUESTED" ? "current" : "done" },
    { label: "Ready to collect", at: r.readyAt, detail: r.status === "APPROVED" && r.readyAt ? "at the front desk" : null, state: r.readyAt ? (r.status === "APPROVED" ? "current" : "done") : "todo" },
    {
      label: r.collectStatus === "COLLECTED" || !r.paidOut.some((p) => p.method === "online") ? "Collected" : "Refunded", at: r.completedAt,
      detail: r.paidOut.length ? r.paidOut.map((p) => `${formatINR(p.amount)} ${p.method}${p.where ? ` — ${p.where}` : ""}`).join(" · ") : null,
      state: r.status === "COMPLETED" ? "done" : "todo",
    },
  ];
}

function RequestForm({ item, onDone }: { item: MyRefunds["eligible"][number]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((item.refundable / 100).toFixed(2));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>Request refund</Button>;
  return (
    <form
      className="flex w-full flex-col gap-2 rounded-xl border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const paise = parseRupees(amount);
        if (!paise) return setError({ message: "Enter the amount to refund." });
        setBusy(true);
        try {
          await api("/api/refunds/request", { body: { billId: item.billId, amount: paise, note: note.trim() || undefined } });
          setOpen(false);
          onDone();
        } catch (err) {
          setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm">Up to <b>{formatINR(item.refundable)}</b> can be refunded on this item. A manager approves it; you will be told as soon as it is decided.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={1} placeholder="Anything we should know" /></Field>
      </div>
      <RejectionBanner error={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Sending…" : "Send request"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function MyRefundsView() {
  const state = useApi<MyRefunds>("/api/portal/refunds");
  const ref = useSearchParams().get("ref");
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold">My refunds</h1>
          {d.ready.count ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-4" data-testid="refund-ready-banner">
              <p className="font-semibold">{formatINR(d.ready.amount)} refund ready to collect at the front desk.</p>
              <RefundQrButton refunds={d.refunds.filter((r) => r.token)} />
            </div>
          ) : null}
          {d.eligible.length ? (
            <Card>
              <CardHeader><CardTitle>Items you can ask a refund for</CardTitle></CardHeader>
              <CardContent className="flex flex-col divide-y">
                {d.eligible.map((e) => (
                  <div key={e.billId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid="refund-eligible">
                    <div>
                      <p className="font-medium">{e.what}{e.forName ? <span className="text-muted-foreground"> · {e.forName}</span> : null}</p>
                      <p className="text-xs text-muted-foreground">{e.reason} · paid {formatINR(e.paid)} · <b>{formatINR(e.refundable)} left to refund</b></p>
                    </div>
                    <RequestForm item={e} onDone={() => void state.reload()} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          {d.refunds.length === 0 ? (
            <Empty title="No refunds yet" />
          ) : (
            d.refunds.map((r) => {
              const l = label(r);
              return (
                <Card key={r.id} className={cn(ref === r.code && "ring-2 ring-primary")} data-testid="my-refund">
                  <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex flex-wrap items-center gap-2"><Money paise={r.amount} /> <Badge tone={l.tone}>{l.text}</Badge></CardTitle>
                      <p className="text-sm text-muted-foreground"><span className="font-mono">{r.code}</span> · {r.what}{r.forName ? ` · ${r.forName}` : ""}</p>
                      <p className="text-xs text-muted-foreground">{r.reason}{r.note ? ` · “${r.note}”` : ""}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {r.token ? <RefundQrButton refunds={[r]} label="Show QR" /> : null}
                      {r.status === "COMPLETED" ? (
                        <Button asChild size="sm" variant="outline"><Link href={`/portal/refunds/${r.id}/receipt`}><FileText className="h-4 w-4" /> Receipt</Link></Button>
                      ) : null}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Timeline steps={steps(r)} />
                    {r.status === "APPROVED" && r.token ? (
                      <p className="mt-1 flex items-center gap-1 text-sm"><QrCode className="h-4 w-4" /> Collect {formatINR(r.toCollect)} in cash at the front desk: show the QR or your member card.</p>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      )}
    </DataState>
  );
}
