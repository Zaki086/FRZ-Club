"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { fmtDate, fmtDateTime } from "@/lib/time";

type Leave = { id: string; name: string; type: string; startDate: string; endDate: string; days: number; reason: string; status: string; decisionNote: string | null; createdAt: string };

function Decide({ row, onDone }: { row: Leave; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string; unassignedShifts: number }>(`/api/staff/leave/${row.id}/decide`, { body: { decision, note: note || undefined } });
      onDone(`${row.name}: leave ${r.status.toLowerCase()}${r.status === "APPROVED" ? ` — ${r.unassignedShifts} shift${r.unassignedShifts === 1 ? "" : "s"} unassigned and now open on the roster` : ""}.`);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <Input className="h-9 w-48" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" disabled={busy} onClick={() => decide("APPROVED")}>Approve</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("REJECTED")}>Reject</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function LeaveApprovals() {
  const [status, setStatus] = useState("PENDING");
  const [msg, setMsg] = useState<string | null>(null);
  const state = useApi<Leave[]>(`/api/staff/leave${status ? `?status=${status}` : ""}`);
  return (
    <div className="flex flex-col gap-3">
      <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
        <option value="PENDING">Pending</option>
        <option value="APPROVED">Approved</option>
        <option value="REJECTED">Rejected</option>
        <option value="">All</option>
      </Select>
      {msg ? <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">{msg}</p> : null}
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: status === "PENDING" ? "No pending requests" : "No requests" }}>
          {(rows) => (
            <div className="divide-y">
              {rows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
                  <div>
                    <p className="font-semibold">{r.name} <StatusBadge status={r.status} /></p>
                    <p className="text-sm">{r.type.toLowerCase()} · {fmtDate(r.startDate)} – {fmtDate(r.endDate)} ({r.days} day{r.days === 1 ? "" : "s"})</p>
                    <p className="text-sm text-muted-foreground">{r.reason}</p>
                    {r.decisionNote ? <p className="text-xs text-muted-foreground">Note: {r.decisionNote}</p> : null}
                    <p className="text-xs text-muted-foreground">Requested {fmtDateTime(r.createdAt)}</p>
                  </div>
                  {r.status === "PENDING" ? <Decide row={r} onDone={(m) => { setMsg(m); void state.reload(); }} /> : null}
                </div>
              ))}
            </div>
          )}
        </DataState>
      </Card>
    </div>
  );
}
