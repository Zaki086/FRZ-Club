"use client";
// v4 §3.3/§3.5: one refund — what it is for, the timeline (Requested → Approved → Ready to collect → Collected), who
// asked, who decided, how and where it was paid out, and the next action (approve / reject, pay out, receipt).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Printer } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Money } from "@/components/money";
import { DataState, RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINR } from "@/lib/money";
import { Decide } from "../refunds-queue";
import { PayOutLoader } from "../payout";
import { Timeline } from "@/components/refund-timeline";
import { SendMessageButton } from "@/components/message-composer";

type Detail = {
  id: string; code: string; status: string; collectStatus: string | null; amount: number; reasonLabel: string; note: string; policy: string | null;
  autoApproved: boolean; requestedVia: string; requestedBy: string | null; requestedByName: string | null; decidedByName: string | null;
  decisionNote: string | null; failureReason: string | null; createdAt: string; decidedAt: string | null; readyAt: string | null; completedAt: string | null;
  customer: string; what: string; originalCode: string | null; billTotal: number; refundableLeft: number; remindersSent: number;
  identityCheckedByName: string | null; identityMethod: string | null;
  paidOut: Array<{ method: string; methodLabel: string; amount: number; at: string; by: string | null; where: string | null }>;
  payments: Array<{ id: string; method: string; amount: number; status: string }>;
};

const IDENTITY: Record<string, string> = { REFUND_QR: "refund QR", MEMBER_CARD: "member card", SEARCH: "search + photo", GUEST_PHONE_CODE: "guest phone + original code" };

export function RefundDetail({ id, me, canApprove, isOwner, managerLimit, canMessage = false }: { id: string; me: string; canApprove: boolean; isOwner: boolean; managerLimit: number; canMessage?: boolean }) {
  const state = useApi<Detail>(`/api/refunds/${id}`);
  const router = useRouter();
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <DataState state={state}>
      {(r) => {
        const rejected = r.status === "REJECTED" || r.status === "CANCELLED" || r.status === "FAILED";
        const approvedState = r.status === "REQUESTED" ? "current" : rejected ? "stopped" : "done";
        const steps = [
          { label: "Requested", at: r.createdAt, detail: r.requestedByName ? `by ${r.requestedByName}` : r.requestedVia === "SYSTEM" ? "by the system" : null, state: "done" as const },
          rejected
            ? { label: r.status === "REJECTED" ? "Not approved" : r.status === "FAILED" ? "Failed" : "Withdrawn", at: r.decidedAt, detail: r.decisionNote ?? r.failureReason, state: "stopped" as const }
            : { label: "Approved", at: r.decidedAt, detail: r.autoApproved ? `by policy (${r.policy ?? "rule"})` : r.decidedByName ? `by ${r.decidedByName}` : null, state: approvedState as "done" | "current" },
          { label: "Ready to collect", at: r.readyAt, detail: r.remindersSent ? `${r.remindersSent} reminder${r.remindersSent > 1 ? "s" : ""} sent` : null, state: r.readyAt ? (r.status === "APPROVED" ? ("current" as const) : ("done" as const)) : ("todo" as const) },
          { label: r.collectStatus === "COLLECTED" ? "Collected" : "Paid out", at: r.completedAt, detail: r.paidOut.length ? r.paidOut.map((p) => `${formatINR(p.amount)} ${p.methodLabel}${p.where ? ` at the ${p.where}` : ""}${p.by ? ` by ${p.by}` : ""}`).join(" · ") : null, state: r.status === "COMPLETED" ? ("done" as const) : ("todo" as const) },
        ];
        const mayDecide = r.status === "REQUESTED" && canApprove && r.requestedBy !== me && (r.amount <= managerLimit || isOwner);
        const waiting = r.payments.filter((p) => p.status === "PENDING").reduce((a, p) => a + p.amount, 0);
        return (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Money paise={r.amount} /> <Badge tone={r.status === "COMPLETED" ? "green" : r.status === "APPROVED" ? "blue" : r.status === "REQUESTED" ? "amber" : "neutral"}>
                    {r.status === "APPROVED" && r.collectStatus === "READY_TO_COLLECT" ? "Ready to collect" : r.collectStatus === "COLLECTED" ? "Collected" : r.status.toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                  </Badge>
                </CardTitle>
                <span className="flex flex-wrap items-center gap-2">
                  {canMessage ? <SendMessageButton context="REFUND" recordId={r.id} /> : null}
                  {r.status === "COMPLETED" ? (
                    <Button asChild variant="outline"><Link href={`/print/refund/${r.id}`} target="_blank"><Printer className="h-4 w-4" /> Print receipt</Link></Button>
                  ) : null}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Timeline steps={steps} />
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <dt className="text-muted-foreground">For</dt><dd>{r.what}</dd>
                  <dt className="text-muted-foreground">Customer</dt><dd>{r.customer}</dd>
                  <dt className="text-muted-foreground">Reason</dt><dd>{r.reasonLabel}{r.note ? ` · ${r.note}` : ""}</dd>
                  <dt className="text-muted-foreground">Original bill</dt><dd>{r.originalCode ? `${r.originalCode} · ` : ""}{formatINR(r.billTotal)}; {formatINR(r.refundableLeft)} still refundable</dd>
                  {r.identityCheckedByName ? (<><dt className="text-muted-foreground">Identity checked</dt><dd>by {r.identityCheckedByName}{r.identityMethod ? ` (${IDENTITY[r.identityMethod] ?? r.identityMethod})` : ""}</dd></>) : null}
                </dl>
              </CardContent>
            </Card>
            {mayDecide ? (
              <Card><CardContent className="pt-4"><Decide id={r.id} code={r.code} amount={r.amount} onDone={() => void state.reload()} /></CardContent></Card>
            ) : r.status === "REQUESTED" ? (
              <p className="text-sm text-muted-foreground">
                {r.requestedBy === me ? "You asked for this refund: someone else approves it." : r.amount > managerLimit && !isOwner ? `Above the Manager limit of ${formatINR(managerLimit)}: the Owner approves.` : "Waiting for a manager's approval."}
              </p>
            ) : null}
            {r.status === "APPROVED" && waiting > 0 ? (
              <Card>
                <CardHeader><CardTitle>Pay out at the desk</CardTitle></CardHeader>
                <CardContent><PayOutLoader id={r.id} onDone={() => void state.reload()} /></CardContent>
              </Card>
            ) : null}
            {r.status === "FAILED" && canApprove ? (
              <Button
                variant="outline"
                className="self-start"
                onClick={async () => {
                  setError(null);
                  try {
                    const again = await api<{ id: string }>(`/api/refunds/${r.id}/retry`, { body: {} });
                    router.push(`/app/refunds/${again.id}`);
                  } catch (e) {
                    setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                  }
                }}
              >
                Pay at the desk instead
              </Button>
            ) : null}
            <RejectionBanner error={error} />
            <Link href="/app/refunds" className="text-sm font-semibold text-primary underline">← All refunds</Link>
          </div>
        );
      }}
    </DataState>
  );
}
