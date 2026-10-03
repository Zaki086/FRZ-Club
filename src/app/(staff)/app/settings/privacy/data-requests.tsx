"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/time";

type Row = { id: string; kind: string; status: string; note: string | null; createdAt: string; handledAt: string | null; memberId: string; member: { name: string; memberCode: string; anonymisedAt: string | null } | null };

function Decide({ r, onDone }: { r: Row; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const go = async (approve: boolean) => {
    setError(null);
    try {
      await api(`/api/privacy/requests/${r.id}`, { body: { approve, note } });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <Input className="h-8 w-56" placeholder="Decision note (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
        <Button size="sm" variant="destructive" disabled={note.trim().length < 3} onClick={() => go(true)}>Erase</Button>
        <Button size="sm" variant="outline" disabled={note.trim().length < 3} onClick={() => go(false)}>Reject</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function DataRequests() {
  const state = useApi<Row[]>("/api/privacy/requests");
  return (
    <DataState state={state}>
      {(rows) =>
        rows.filter((r) => r.kind === "ERASE").length === 0 ? (
          <Empty title="No erasure requests" />
        ) : (
          <div className="flex flex-col divide-y rounded-md border">
            {rows.filter((r) => r.kind === "ERASE").map((r) => (
              <div key={r.id} className="flex flex-col gap-2 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{r.member?.name ?? "?"}</span> <span className="font-mono text-xs">{r.member?.memberCode}</span> · asked {fmtDateTime(r.createdAt)}
                  </span>
                  <Badge tone={r.status === "OPEN" ? "amber" : r.status === "DONE" ? "green" : "neutral"}>{r.status.toLowerCase()}</Badge>
                </div>
                {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                {r.status === "OPEN" ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <a className="text-xs text-primary underline" href={`/api/privacy/members/${r.memberId}/export`} download>Download their data</a>
                    <Decide r={r} onDone={() => void state.reload()} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      }
    </DataState>
  );
}
