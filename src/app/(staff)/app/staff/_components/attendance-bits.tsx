"use client";
// v3 §4.3: shared pieces for attendance rows — the flag chips (AT-2…AT-5) and the Manager's correction dialog (AT-5).
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { useListReload } from "@/components/list/filtered-list";
import { hmm } from "@/lib/duration";
import { fmtDateTime, istDate, istTime } from "@/lib/time";

export type AttRow = {
  id: string; employee_id: string; name: string; role: string; clock_in: string; clock_out: string | null;
  sched_start: string | null; sched_end: string | null; area: string | null; worked_min: number | null; scheduled_min: number | null;
  late_min: number; early_min: number; overtime_min: number; missing: boolean; edited: boolean;
  original_clock_in: string | null; original_clock_out: string | null; correction_reason: string | null; corrected_by: string | null;
};

export function AttendanceFlags({ r }: { r: AttRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      {r.late_min > 0 ? <Badge tone="amber">Late {hmm(r.late_min)}</Badge> : null}
      {r.early_min > 0 ? <Badge tone="amber">Left {hmm(r.early_min)} early</Badge> : null}
      {r.overtime_min > 0 ? <Badge tone="blue">Overtime {hmm(r.overtime_min)}</Badge> : null}
      {r.missing ? <Badge tone="red">Missing clock-out</Badge> : null}
      {r.edited ? <Badge tone="neutral" title={r.correction_reason ?? undefined}>Edited</Badge> : null}
      {!r.sched_start ? <Badge tone="neutral">No shift</Badge> : null}
    </span>
  );
}

/** What was originally recorded, when a Manager has corrected it. */
export function EditedNote({ r }: { r: AttRow }) {
  if (!r.edited) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Edited by {r.corrected_by ?? "a manager"}: {r.correction_reason}. Originally {r.original_clock_in ? fmtDateTime(r.original_clock_in) : "—"} → {r.original_clock_out ? fmtDateTime(r.original_clock_out) : "not clocked out"}.
    </p>
  );
}

const toLocal = (iso: string | null) => (iso ? `${istDate(new Date(iso))}T${istTime(new Date(iso))}` : "");
const fromLocal = (v: string) => (v ? `${v}:00+05:30` : undefined);

export function CorrectAttendance({ r, onDone }: { r: AttRow; onDone?: () => void }) {
  const reloadList = useListReload();
  const [open, setOpen] = useState(false);
  const [clockIn, setClockIn] = useState(toLocal(r.clock_in));
  const [clockOut, setClockOut] = useState(toLocal(r.clock_out));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  // Clicks inside the dialog must not toggle the table row it sits in (React events bubble through portals).
  return (
    <span onClick={(e) => e.stopPropagation()}>
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{r.clock_out ? "Correct" : "Fix clock-out"}</Button>
      <DialogContent title={`Correct ${r.name}'s attendance`} description="Times are IST. The original times are kept and the change is recorded with your reason.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const body: Record<string, string | undefined> = { reason };
              if (clockIn !== toLocal(r.clock_in)) body.clockIn = fromLocal(clockIn);
              if (clockOut !== toLocal(r.clock_out)) body.clockOut = fromLocal(clockOut);
              await api(`/api/staff/attendance/${r.id}/correct`, { body });
              setOpen(false);
              setReason("");
              (onDone ?? reloadList)();
            } catch (err) {
              setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Clock-in"><Input type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} required /></Field>
            <Field label="Clock-out"><Input type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></Field>
          </div>
          <Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} /></Field>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save correction"}</Button>
        </form>
      </DialogContent>
    </Dialog>
    </span>
  );
}

export function AttendanceTabs({ active }: { active: "log" | "summary" }) {
  const cls = (on: boolean) => `rounded-full px-4 py-1.5 text-sm font-semibold ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`;
  return (
    <nav className="mb-3 inline-flex gap-1 rounded-full border bg-card p-1" aria-label="Attendance views">
      <a href="/app/staff/attendance" className={cls(active === "log")} aria-current={active === "log" ? "page" : undefined}>Log</a>
      <a href="/app/staff/attendance/summary" className={cls(active === "summary")} aria-current={active === "summary" ? "page" : undefined}>Summary per employee</a>
    </nav>
  );
}
