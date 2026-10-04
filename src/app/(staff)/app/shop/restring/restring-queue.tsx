"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/badges";
import { cn } from "@/components/ui/cn";
import { fmtDateTime } from "@/lib/time";
import { useNow } from "../_components/use-now";

type Ticket = { id: string; code: string; customerName: string; memberId?: string | null; racket: string; notes: string; status: string; promisedAt: string; createdAt: string };

const NEXT: Record<string, { to: string; label: string }> = {
  RECEIVED: { to: "IN_PROGRESS", label: "Start stringing" },
  IN_PROGRESS: { to: "READY", label: "Mark ready (notify)" },
  READY: { to: "COLLECTED", label: "Collected" },
};

function TicketRow({ t, onDone, now, canAdvance }: { t: Ticket; onDone: () => void; now: number; canAdvance: boolean }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const overdue = ["RECEIVED", "IN_PROGRESS"].includes(t.status) && new Date(t.promisedAt).getTime() < now;
  const next = NEXT[t.status];
  return (
    <div className={cn("flex flex-wrap items-center gap-3 p-3", overdue && "bg-red-50")}>
      <div className="min-w-48 flex-1">
        <p className="font-semibold">{t.racket} <span className="font-mono text-xs text-muted-foreground">{t.code}</span></p>
        <p className="text-sm">{t.customerName}{t.memberId === null ? <span className="text-muted-foreground"> · Walk-in</span> : null}{t.notes ? <span className="text-muted-foreground"> · {t.notes}</span> : null}</p>
      </div>
      <div className="text-sm">
        Promised {fmtDateTime(t.promisedAt)} {overdue ? <Badge tone="red">OVERDUE</Badge> : null}
      </div>
      <StatusBadge status={t.status} />
      {canAdvance && next ? (
        <Button size="lg" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await api(`/api/shop/tickets/${t.id}/status`, { body: { status: next.to } }); onDone(); }
          catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
          finally { setBusy(false); }
        }}>{next.label}</Button>
      ) : null}
      {error ? <div className="w-full"><RejectionBanner error={error} /></div> : null}
    </div>
  );
}

export function RestringQueue({ canAdvance }: { canAdvance: boolean }) {
  const [all, setAll] = useState(false);
  const state = useApi<Ticket[]>(all ? "/api/shop/tickets" : "/api/shop/tickets?open=1", { pollMs: 30000 });
  const now = useNow();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button size="sm" variant={!all ? "default" : "outline"} onClick={() => setAll(false)}>Open tickets</Button>
        <Button size="sm" variant={all ? "default" : "outline"} onClick={() => setAll(true)}>All tickets</Button>
      </div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No restring tickets" }}>
          {(rows) => <div className="divide-y">{rows.map((t) => <TicketRow key={t.id} t={t} now={now} canAdvance={canAdvance} onDone={() => void state.reload()} />)}</div>}
        </DataState>
      </Card>
    </div>
  );
}
