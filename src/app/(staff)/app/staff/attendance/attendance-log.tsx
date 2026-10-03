"use client";
// v3 §4.3 AT-1…AT-5: the attendance log with the standard FilterBar; managers correct a row with a reason.
import Link from "next/link";
import { FilteredList } from "@/components/list/filtered-list";
import { hmm } from "@/lib/duration";
import { fmtDay, fmtRange, istDate, istTime } from "@/lib/time";
import { AttendanceFlags, CorrectAttendance, EditedNote, type AttRow } from "../_components/attendance-bits";

export function AttendanceLog({ canCorrect, selfEmployeeId }: { canCorrect: boolean; selfEmployeeId: string | null }) {
  return (
    <FilteredList<AttRow>
      list="attendance"
      searchPlaceholder="Employee name"
      pollMs={60_000}
      columns={[
        { key: "name", header: "Employee", cell: (r) => <Link className="font-semibold text-primary hover:underline" href={`/app/staff/employees/${r.employee_id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
        { key: "day", header: "Day", cell: (r) => fmtDay(istDate(new Date(r.clock_in))) },
        { key: "shift", header: "Shift", cell: (r) => (r.sched_start && r.sched_end ? fmtRange(r.sched_start, r.sched_end) : <span className="text-muted-foreground">—</span>) },
        { key: "in", header: "In – out", cell: (r) => <span className="tabular">{istTime(new Date(r.clock_in))} – {r.clock_out ? istTime(new Date(r.clock_out)) : <span className="font-semibold text-warning-text">still in</span>}</span> },
        { key: "worked", header: "Worked", className: "text-right", cell: (r) => <span className="tabular">{r.worked_min === null ? "—" : hmm(r.worked_min)}</span> },
        { key: "flags", header: "Flags", cell: (r) => <AttendanceFlags r={r} /> },
        { key: "next", header: "", cell: (r) => (canCorrect && r.employee_id !== selfEmployeeId ? <CorrectAttendance r={r} /> : null) },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          <span>{r.scheduled_min !== null ? `Scheduled ${hmm(r.scheduled_min)}${r.area ? ` · ${r.area.replace("_", " ").toLowerCase()}` : ""}` : "Clocked in without a rostered shift"}</span>
          <EditedNote r={r} />
        </div>
      )}
      empty={{ title: "No attendance for these filters", hint: "Widen the dates or remove a filter." }}
    />
  );
}
