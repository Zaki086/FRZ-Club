"use client";
// v3 §3.2: members' data requests with the standard FilterBar (opens on erasure requests). An open erasure request
// carries its next action: download their data, then erase or reject with a note.
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Row = {
  id: string; kind: string; status: string; note: string | null; created_at: string; handled_at: string | null; member_id: string;
  member_name: string | null; member_code: string | null; anonymised_at: string | null; handled_by_name: string | null;
};

function Decide({ r }: { r: Row }) {
  const reload = useListReload();
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const go = async (approve: boolean) => {
    setError(null);
    try {
      await api(`/api/privacy/requests/${r.id}`, { body: { approve, note } });
      reload();
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
  return (
    <FilteredList<Row>
      list="data-requests"
      searchPlaceholder="Member name, code or note"
      columns={[
        {
          key: "member", header: "Member", cell: (r) => (
            <span className="flex flex-col">
              <span className="font-medium">{r.member_name ?? "?"}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.member_code}</span>
            </span>
          ),
        },
        {
          key: "kind", header: "Request", className: "max-w-xs", cell: (r) => (
            <span className="flex flex-col">
              <span>{r.kind === "ERASE" ? "Erase their data" : "Downloaded their data"}</span>
              {r.note ? <span className="line-clamp-2 text-xs text-muted-foreground">{r.note}</span> : null}
            </span>
          ),
        },
        { key: "asked", header: "Asked", cell: (r) => <RelTime when={r.created_at} className="text-xs" /> },
        { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "OPEN" ? "amber" : r.status === "DONE" ? "green" : "neutral"}>{r.status.toLowerCase()}</Badge> },
        {
          key: "next", header: "", cell: (r) =>
            r.status === "OPEN" && r.kind === "ERASE" ? (
              <div className="flex flex-wrap items-start gap-2" onClick={(e) => e.stopPropagation()}>
                <a className="text-xs text-primary underline" href={`/api/privacy/members/${r.member_id}/export`} download>Download their data</a>
                <Decide r={r} />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {r.handled_by_name ? `by ${r.handled_by_name}` : ""}
                {r.handled_at ? <> · <RelTime when={r.handled_at} /></> : null}
              </span>
            ),
        },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          {r.note ? <p className="text-xs">{r.note}</p> : <p className="text-xs text-muted-foreground">No note.</p>}
          {r.anonymised_at ? <p className="text-xs">Personal data erased <RelTime when={r.anonymised_at} />.</p> : null}
        </div>
      )}
      empty={{ title: "No data requests for these filters" }}
    />
  );
}
