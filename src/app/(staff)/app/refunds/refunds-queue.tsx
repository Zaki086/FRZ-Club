"use client";
// v3 RF-6: the refunds queue with the standard FilterBar and summary strip. The next action is on each row:
// Approve / Reject (approvers, never their own; Manager up to the limit), Pay out (ready), Pay at the desk (failed),
// Withdraw (the person who asked).
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, useTenderMethods, type TenderDraft, type TenderMethod } from "@/components/tender-fields";
import { REFUND_REASON_OPTIONS } from "@/components/refund-request";
import { formatINR } from "@/lib/money";

type Row = {
  id: string; code: string; created_at: string; customer: string; source: string; amount: number; reason: string; note: string;
  status: string; auto_approved: boolean; policy: string | null; requested_by: string | null; requested_by_name: string | null;
  requested_via: string; decided_by_name: string | null; decision_note: string | null; completed_at: string | null; failure_reason: string | null;
  needs_owner: boolean; pending_amount: number; paid_methods: string | null; original_methods: string[] | null;
};

const STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "red" | "neutral" }> = {
  REQUESTED: { label: "Awaiting approval", tone: "amber" }, APPROVED: { label: "Ready to pay out", tone: "blue" }, COMPLETED: { label: "Completed", tone: "green" },
  FAILED: { label: "Failed", tone: "red" }, REJECTED: { label: "Rejected", tone: "neutral" }, CANCELLED: { label: "Withdrawn", tone: "neutral" },
};
const REASON = Object.fromEntries(REFUND_REASON_OPTIONS.map((o) => [o.value, o.label]));
const SOURCE: Record<string, string> = {
  BOOKING: "Court booking", SOCIAL_JOIN: "Social play", MEMBERSHIP: "Membership", COUNTER_SALE: "Shop sale", SHOP_ORDER: "Online order",
  SERVICE_TICKET: "Restring", BAR_TAB: "Bar tab", INVOICE: "Invoice",
};

function useAction() {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function Decide({ r }: { r: Row }) {
  const { busy, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        <Input className="h-9 w-56" placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Decision note for ${r.code}`} />
        <Button size="sm" disabled={busy} onClick={() => run(() => api(`/api/refunds/${r.id}/approve`, { body: { note: note || undefined } }))}>Approve {formatINR(r.amount)}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/api/refunds/${r.id}/reject`, { body: { note } }))}>Reject</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

function PayOut({ r }: { r: Row }) {
  const methods = useTenderMethods() ?? ["CASH"];
  const original = (r.original_methods ?? []).find((m): m is TenderMethod => (methods as string[]).includes(m));
  const [t, setT] = useState<TenderDraft>(emptyTender(original ?? "CASH"));
  const { busy, error, setError, run } = useAction();
  return (
    <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()} data-testid="refund-payout">
      <p className="text-xs text-muted-foreground">
        Paid with {(r.original_methods ?? []).map((m) => m.toLowerCase()).join(" + ") || "—"}. Pay {formatINR(r.pending_amount)} back the same way where you can.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <MethodSelect methods={methods} value={t.method} onChange={(m) => setT({ ...t, method: m })} />
        <ProofFields kind="refund" className="sm:col-span-2" value={t} onChange={(p) => setT({ ...t, ...p })} />
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const proof = tenderProof(t, "refund");
              await api(`/api/refunds/${r.id}/pay-out`, { body: { method: proof.method, reference: "reference" in proof ? proof.reference : undefined, approvalCode: "approvalCode" in proof ? proof.approvalCode : undefined } });
            })
          }
        >
          Paid out
        </Button>
      </div>
      {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
    </div>
  );
}

function NextAction({ r, me, canApprove, isOwner }: { r: Row; me: string; canApprove: boolean; isOwner: boolean }) {
  const { busy, error, run } = useAction();
  if (r.status === "REQUESTED") {
    if (r.requested_by === me) {
      return (
        <span className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-muted-foreground">Waiting for {r.needs_owner ? "the Owner" : "a manager"}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/refunds/${r.id}/cancel`, { body: {} }))}>Withdraw</Button>
          <RejectionBanner error={error} />
        </span>
      );
    }
    if (!canApprove) return <span className="text-xs text-muted-foreground">Waiting for approval</span>;
    if (r.needs_owner && !isOwner) return <span className="text-xs text-muted-foreground">Needs the Owner (above the limit)</span>;
    return <span className="text-sm font-semibold text-primary">Approve or reject ↓</span>;
  }
  if (r.status === "APPROVED") return <span className="text-sm font-semibold text-primary">Pay out {formatINR(r.pending_amount)} ↓</span>;
  if (r.status === "FAILED" && canApprove) {
    return (
      <span className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/api/refunds/${r.id}/retry`, { body: {} }))}>Pay at the desk instead</Button>
        <RejectionBanner error={error} />
      </span>
    );
  }
  return null;
}

export function RefundsQueue({ userId, canApprove, isOwner, managerLimit }: { userId: string; canApprove: boolean; isOwner: boolean; managerLimit: number }) {
  return (
    <FilteredList<Row>
      list="refunds"
      searchPlaceholder="RF-000123, customer or note"
      pollMs={30_000}
      columns={[
        { key: "code", header: "Refund", cell: (r) => (
          <span className="flex flex-col">
            <span className="font-mono text-sm font-semibold">{r.code}</span>
            <RelTime when={r.created_at} className="text-xs text-muted-foreground" />
          </span>
        ) },
        { key: "customer", header: "Customer", cell: (r) => <span className="flex flex-col"><span className="font-semibold">{r.customer}</span><span className="text-xs text-muted-foreground">{SOURCE[r.source] ?? r.source}</span></span> },
        { key: "amount", header: "Amount", className: "text-right", cell: (r) => <Money paise={r.amount} className="font-semibold" /> },
        { key: "reason", header: "Reason", cell: (r) => <span className="text-sm">{REASON[r.reason] ?? r.reason}{r.auto_approved ? <Badge tone="neutral" className="ml-1">policy</Badge> : null}</span> },
        { key: "status", header: "Status", cell: (r) => <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge> },
        { key: "next", header: "Next", cell: (r) => <NextAction r={r} me={userId} canApprove={canApprove} isOwner={isOwner} /> },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-3 text-sm">
          <div className="grid gap-1 sm:grid-cols-2">
            <span>{r.note}</span>
            <span className="text-muted-foreground">
              Asked by {r.requested_by_name ?? (r.requested_via === "SYSTEM" ? "the system" : "—")}
              {r.decided_by_name ? ` · ${r.status === "REJECTED" ? "rejected" : "approved"} by ${r.decided_by_name}` : r.auto_approved ? ` · approved by policy (${r.policy})` : ""}
              {r.decision_note ? ` · “${r.decision_note}”` : ""}
              {r.paid_methods ? ` · paid by ${r.paid_methods.toLowerCase()}` : ""}
              {r.failure_reason ? ` · ${r.failure_reason}` : ""}
            </span>
          </div>
          {r.status === "REQUESTED" && canApprove && r.requested_by !== userId && (!r.needs_owner || isOwner) ? <Decide r={r} /> : null}
          {r.status === "APPROVED" && r.pending_amount > 0 ? <PayOut r={r} /> : null}
          {r.status === "REQUESTED" && r.needs_owner ? <p className="text-xs text-muted-foreground">Above the Manager limit of {formatINR(managerLimit)}: the Owner approves.</p> : null}
        </div>
      )}
      empty={{ title: "No refunds match these filters", hint: "Ask for a refund from the bill (booking, sale, membership or tab)." }}
    />
  );
}
