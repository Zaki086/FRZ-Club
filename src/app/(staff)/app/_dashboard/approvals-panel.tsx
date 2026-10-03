"use client";
// v4 RN-4: "Needs your approval" at the top of the Owner and Manager dashboards. Rows come from /api/approvals
// (services/approvals.ts); Approve / Reject happen inline (a reason is required to reject) through the same services
// the detail pages use, and every row links to its detail page.
import Link from "next/link";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Kind = "REFUND" | "LEAVE" | "ATTENDANCE" | "DRAWER_VARIANCE";
type Item = { kind: Kind; id: string; title: string; detail: string; amountPaise: number | null; requestedBy: string; requestedAt: string; href: string };

const KIND: Record<Kind, { label: string; tone: "amber" | "blue" | "red" | "purple" }> = {
  REFUND: { label: "Refund", tone: "amber" },
  LEAVE: { label: "Leave", tone: "blue" },
  ATTENDANCE: { label: "Attendance", tone: "purple" },
  DRAWER_VARIANCE: { label: "Drawer variance", tone: "red" },
};

function Row({ i, onDone }: { i: Item; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/approvals/decide", { body: { kind: i.kind, id: i.id, decision, reason: reason.trim() || undefined } });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="approval-row" data-kind={i.kind}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND[i.kind].tone}>{KIND[i.kind].label}</Badge>
            <Link href={i.href} className="font-semibold text-primary hover:underline">{i.title}</Link>
            {i.amountPaise !== null ? <Money paise={i.amountPaise} className="font-semibold" /> : null}
          </p>
          <p className="text-sm text-muted-foreground">{i.detail}</p>
          <p className="text-xs text-muted-foreground">
            {i.requestedBy} · <RelTime when={i.requestedAt} />
          </p>
        </div>
        {i.kind === "ATTENDANCE" ? (
          <Button asChild size="sm" variant="outline"><Link href={i.href}>Correct</Link></Button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide("APPROVE")} aria-label={`Approve ${i.title}`}>Approve</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting} aria-label={`Reject ${i.title}`}>Reject</Button>
          </div>
        )}
      </div>
      {rejecting ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("REJECT");
          }}
        >
          <Input className="h-9 min-w-56 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (required)" aria-label={`Reason for rejecting ${i.title}`} />
          <Button size="sm" variant="destructive" type="submit" disabled={busy || reason.trim().length < 3}>Reject</Button>
        </form>
      ) : null}
      <RejectionBanner error={error} />
    </li>
  );
}

export function ApprovalsPanel() {
  const state = useApi<Item[]>("/api/approvals", { pollMs: 60_000 });
  return (
    <DataState state={state}>
      {(items) => (
        <Card data-testid="approvals-panel" aria-label="Needs your approval">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Needs your approval</CardTitle>
            <span className="text-sm text-muted-foreground">{items.length ? `${items.length} waiting` : "Nothing waiting"}</span>
          </CardHeader>
          <CardContent className="p-0">
            {items.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">No refunds, leave, missing clock-outs or drawer variances wait for you.</p>
            ) : (
              <ul className="divide-y border-t">
                {items.map((i) => <Row key={`${i.kind}:${i.id}`} i={i} onDone={() => void state.reload()} />)}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </DataState>
  );
}
