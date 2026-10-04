"use client";
// v3 RF-6 / v4 §3.5: the front desk "Refunds" page — tabs (Ready to pay out · Awaiting approval · Requested by members
// · Completed · Rejected) over the standard FilterBar, and a summary strip that reads the same on every tab:
// Ready to collect (count, ₹) · Awaiting approval · Paid out today · Oldest unclaimed (days). The next action is on
// each row: Approve / Reject (approvers, never their own; Manager up to the limit), Pay out (identity check, RF-9),
// Pay at the desk (failed), Withdraw (the person who asked).
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import type { ListData } from "@/components/list/use-list";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { REFUND_REASON_OPTIONS } from "@/components/refund-request";
import { formatINR } from "@/lib/money";
import { PayOutDialog, PayOutLoader } from "./payout";

type Row = {
  id: string; code: string; created_at: string; customer: string; source: string; amount: number; reason: string; note: string;
  status: string; auto_approved: boolean; policy: string | null; requested_by: string | null; requested_by_name: string | null;
  requested_via: string; decided_by_name: string | null; decision_note: string | null; completed_at: string | null; failure_reason: string | null;
  needs_owner: boolean; pending_amount: number; paid_methods: string | null; original_methods: string[] | null;
  collect_status: string | null; ready_at: string | null; days_waiting: number | null; source_code: string | null; identity_checked_by_name: string | null;
};

const STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "red" | "neutral" }> = {
  REQUESTED: { label: "Awaiting approval", tone: "amber" }, APPROVED: { label: "Ready to pay out", tone: "blue" }, COMPLETED: { label: "Completed", tone: "green" },
  FAILED: { label: "Failed", tone: "red" }, REJECTED: { label: "Rejected", tone: "neutral" }, CANCELLED: { label: "Withdrawn", tone: "neutral" },
};
const statusOf = (r: Row) =>
  r.status === "APPROVED" && r.collect_status === "READY_TO_COLLECT" ? { label: "Ready to collect", tone: "blue" as const }
  : r.status === "COMPLETED" && r.collect_status === "COLLECTED" ? { label: "Collected", tone: "green" as const }
  : STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
const REASON = Object.fromEntries(REFUND_REASON_OPTIONS.map((o) => [o.value, o.label]));
const SOURCE: Record<string, string> = {
  BOOKING: "Court booking", SOCIAL_JOIN: "Social play", MEMBERSHIP: "Membership", COUNTER_SALE: "Shop sale", SHOP_ORDER: "Online order",
  SERVICE_TICKET: "Restring", BAR_TAB: "Bar tab", INVOICE: "Invoice",
};

/** v4 §3.5 tabs: each one is a preset of the status / "asked by" filters (the FilterBar shows them as chips). */
export const REFUND_TABS = [
  { key: "READY", label: "Ready to pay out", set: { status: "APPROVED", via: null } },
  { key: "AWAITING", label: "Awaiting approval", set: { status: "REQUESTED", via: null } },
  { key: "MEMBERS", label: "Requested by members", set: { status: null, via: "MEMBER" } },
  { key: "COMPLETED", label: "Completed", set: { status: "COMPLETED", via: null } },
  { key: "REJECTED", label: "Rejected", set: { status: "REJECTED", via: null } },
] as const;

function RefundTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const status = search.get("status");
  const via = search.get("via");
  const active = REFUND_TABS.find((t) => (t.set.status ?? null) === status && (t.set.via ?? null) === via)?.key ?? "";
  return (
    <Tabs
      value={active}
      onValueChange={(key) => {
        const tab = REFUND_TABS.find((t) => t.key === key);
        if (!tab) return;
        const next = new URLSearchParams(search.toString());
        for (const [k, v] of Object.entries(tab.set)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        next.delete("page");
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      }}
    >
      <TabsList aria-label="Refund stages">
        {REFUND_TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  );
}

/** The summary strip of §3.5 (the same on every tab). */
function Strip({ data, update }: { data: ListData<Row>; update: (p: Record<string, string | null>) => void }) {
  const v = Object.fromEntries(data.summary.map((s) => [s.key, s.value]));
  const tile = (label: string, value: ReactNode, apply: Record<string, string | null>, testid: string) => (
    <button type="button" onClick={() => update(apply)} data-testid={testid}
      className="flex flex-col items-start rounded-2xl border bg-card p-3 text-left shadow-soft transition hover:-translate-y-px hover:border-primary">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="font-display text-2xl font-bold tabular">{value}</span>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="summary-strip">
      {tile("Ready to collect", <>{v.ready ?? 0} · {formatINR(v.ready_amount ?? 0)}</>, { status: "APPROVED", via: null }, "strip-ready")}
      {tile("Awaiting approval", (v.awaiting ?? 0).toLocaleString("en-IN"), { status: "REQUESTED", via: null }, "strip-awaiting")}
      {tile("Paid out today", formatINR(v.today ?? 0), { status: "COMPLETED", via: null, range: "TODAY" }, "strip-today")}
      {tile("Oldest unclaimed", `${v.oldest ?? 0} day${v.oldest === 1 ? "" : "s"}`, { status: "APPROVED", via: null, sort: "oldest" }, "strip-oldest")}
    </div>
  );
}

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

export function Decide({ id, code, amount, onDone }: { id: string; code: string; amount: number; onDone?: () => void }) {
  const { busy, error, run } = useAction();
  const [note, setNote] = useState("");
  const go = (fn: () => Promise<unknown>) => run(async () => {
    await fn();
    onDone?.();
  });
  return (
    <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        <Input className="h-9 w-56" placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Decision note for ${code}`} />
        <Button size="sm" disabled={busy} onClick={() => go(() => api(`/api/refunds/${id}/approve`, { body: { note: note || undefined } }))}>Approve {formatINR(amount)}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => go(() => api(`/api/refunds/${id}/reject`, { body: { note } }))}>Reject</Button>
      </div>
      <RejectionBanner error={error} />
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
  if (r.status === "APPROVED") {
    return (
      <span className="flex flex-col">
        <span className="text-sm font-semibold text-primary">Pay out {formatINR(r.pending_amount)} ↓</span>
        {r.days_waiting != null ? <span className="text-xs text-muted-foreground">waiting {r.days_waiting} day{r.days_waiting === 1 ? "" : "s"}</span> : null}
      </span>
    );
  }
  if (r.status === "COMPLETED") {
    return <Link className="text-sm font-semibold text-primary underline" href={`/print/refund/${r.id}`} target="_blank" onClick={(e) => e.stopPropagation()}>Receipt</Link>;
  }
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

function RowPayOut({ id }: { id: string }) {
  const reload = useListReload();
  return <PayOutLoader id={id} onDone={reload} />;
}

function Toolbar() {
  const reload = useListReload();
  return <PayOutDialog onChanged={reload} />;
}

export function RefundsQueue({ userId, canApprove, isOwner, managerLimit }: { userId: string; canApprove: boolean; isOwner: boolean; managerLimit: number }) {
  return (
    <div className="flex flex-col gap-3">
      <RefundTabs />
      <FilteredList<Row>
        list="refunds"
        searchPlaceholder="RF-000123, customer, booking/order code or note"
        pollMs={30_000}
        toolbar={<Toolbar />}
        summaryView={(data, update) => <Strip data={data} update={update} />}
        columns={[
          { key: "code", header: "Refund", cell: (r) => (
            <span className="flex flex-col">
              <Link href={`/app/refunds/${r.id}`} className="font-mono text-sm font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{r.code}</Link>
              <RelTime when={r.created_at} className="text-xs text-muted-foreground" />
            </span>
          ) },
          { key: "customer", header: "Customer", cell: (r) => (
            <span className="flex flex-col">
              <span className="font-semibold">{r.customer}</span>
              <span className="text-xs text-muted-foreground">{SOURCE[r.source] ?? r.source}{r.source_code ? ` ${r.source_code}` : ""}{r.requested_via === "MEMBER" ? " · asked by the member" : ""}</span>
            </span>
          ) },
          { key: "amount", header: "Amount", className: "text-right", cell: (r) => <Money paise={r.amount} className="font-semibold" /> },
          { key: "reason", header: "Reason", cell: (r) => <span className="text-sm">{REASON[r.reason] ?? r.reason}{r.auto_approved ? <Badge tone="neutral" className="ml-1">policy</Badge> : null}</span> },
          { key: "status", header: "Status", cell: (r) => <Badge tone={statusOf(r).tone}>{statusOf(r).label}</Badge> },
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
                {r.identity_checked_by_name ? ` · identity checked by ${r.identity_checked_by_name}` : ""}
                {r.failure_reason ? ` · ${r.failure_reason}` : ""}
              </span>
            </div>
            {r.status === "REQUESTED" && canApprove && r.requested_by !== userId && (!r.needs_owner || isOwner) ? <Decide id={r.id} code={r.code} amount={r.amount} /> : null}
            {r.status === "APPROVED" && r.pending_amount > 0 ? <RowPayOut id={r.id} /> : null}
            {r.status === "REQUESTED" && r.needs_owner ? <p className="text-xs text-muted-foreground">Above the Manager limit of {formatINR(managerLimit)}: the Owner approves.</p> : null}
            <Link className="self-start text-xs font-semibold text-primary underline" href={`/app/refunds/${r.id}`}>Open the refund</Link>
          </div>
        )}
        empty={{ title: "No refunds match these filters" }}
      />
    </div>
  );
}
