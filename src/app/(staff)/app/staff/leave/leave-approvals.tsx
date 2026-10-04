"use client";
// v3 §3.2: leave requests with the standard FilterBar (opens on Pending). The next action is on the row:
// approve or reject with an optional note; approving unassigns that person's shifts in the period.
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { fmtDate } from "@/lib/time";

type Leave = {
  id: string; employee_id: string; name: string; role: string; type: string; status: string; start_day: string; end_day: string; days: number;
  reason: string; decided_by_name: string | null; decided_at: string | null; decision_note: string | null; created_at: string; shifts_affected: number;
};

function Decide({ row, onDone }: { row: Leave; onDone: (msg: string) => void }) {
  const reload = useListReload();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string; unassignedShifts: number }>(`/api/staff/leave/${row.id}/decide`, { body: { decision, note: note || undefined } });
      onDone(`${row.name}: leave ${r.status.toLowerCase()}${r.status === "APPROVED" ? ` — ${r.unassignedShifts} shift${r.unassignedShifts === 1 ? "" : "s"} unassigned and now open on the roster` : ""}.`);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        <Input className="h-9 w-48" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" disabled={busy} onClick={() => decide("APPROVED")}>Approve</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("REJECTED")}>Reject</Button>
      </div>
      {row.shifts_affected > 0 ? (
        <p className="text-xs text-muted-foreground">Approving opens {row.shifts_affected} rostered shift{row.shifts_affected === 1 ? "" : "s"} for cover.</p>
      ) : null}
      <RejectionBanner error={error} />
    </div>
  );
}

export function LeaveApprovals() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {msg ? <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">{msg}</p> : null}
      <FilteredList<Leave>
        list="leave"
        searchPlaceholder="Employee, reason or note"
        columns={[
          {
            key: "who", header: "Employee", cell: (r) => (
              <span className="flex flex-col">
                <span className="font-semibold">{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.role.replace(/_/g, " ").toLowerCase()}</span>
              </span>
            ),
          },
          { key: "type", header: "Type", cell: (r) => <span className="capitalize">{r.type.toLowerCase()}</span> },
          {
            key: "dates", header: "Dates", cell: (r) => (
              <span className="flex flex-col">
                <span className="whitespace-nowrap">{fmtDate(r.start_day)}{r.end_day !== r.start_day ? ` – ${fmtDate(r.end_day)}` : ""}</span>
                <RelTime when={r.start_day} className="text-xs text-muted-foreground" />
              </span>
            ),
          },
          { key: "days", header: "Days", className: "text-right", cell: (r) => <span className="tabular">{r.days}</span> },
          { key: "reason", header: "Reason", className: "max-w-xs", cell: (r) => <span className="line-clamp-2 text-sm">{r.reason}</span> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "asked", header: "Requested", cell: (r) => <RelTime when={r.created_at} className="text-xs" /> },
          {
            key: "next", header: "", cell: (r) =>
              r.status === "PENDING" ? (
                <Decide row={r} onDone={setMsg} />
              ) : (
                <span className="text-xs text-muted-foreground">
                  {r.decided_by_name ? `by ${r.decided_by_name}` : r.status === "EXPIRED" ? "not decided in time" : ""}
                  {r.decided_at ? <> · <RelTime when={r.decided_at} /></> : null}
                </span>
              ),
          },
        ]}
        rowExtra={(r) => (
          <div className="flex flex-col gap-1 text-sm">
            <p>{r.reason}</p>
            {r.decision_note ? <p className="text-xs text-muted-foreground">Note: {r.decision_note}</p> : null}
            <p className="text-xs text-muted-foreground">
              {r.shifts_affected > 0 ? `${r.shifts_affected} assigned shift${r.shifts_affected === 1 ? "" : "s"} in this period.` : "No assigned shifts in this period."}
            </p>
          </div>
        )}
        empty={{ title: "No leave requests for these filters" }}
      />
    </div>
  );
}
