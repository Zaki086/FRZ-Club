"use client";
// v3 AT-6: totals per employee for the chosen period (filters + CSV). Payroll formulas are unchanged.
import Link from "next/link";
import { FilteredList } from "@/components/list/filtered-list";
import { hmm } from "@/lib/duration";

type Row = {
  id: string; name: string; role: string; days_worked: number; sessions: number; worked_min: number; scheduled_min: number;
  late_count: number; late_min: number; early_count: number; overtime_min: number; missing: number; edited: number; leave_days: number;
};

const num = (n: number, warn = false) => (n ? <span className={warn ? "font-semibold text-warning-text" : undefined}>{n}</span> : <span className="text-muted-foreground">0</span>);

export function AttendanceSummary() {
  return (
    <FilteredList<Row>
      list="attendance-summary"
      searchPlaceholder="Employee name"
      columns={[
        { key: "name", header: "Employee", cell: (r) => <Link className="font-semibold text-primary hover:underline" href={`/app/staff/employees/${r.id}`}>{r.name}</Link> },
        { key: "days", header: "Days", className: "text-right", cell: (r) => r.days_worked },
        { key: "worked", header: "Worked / scheduled", className: "text-right", cell: (r) => <span className="tabular">{hmm(r.worked_min)} / {hmm(r.scheduled_min)}</span> },
        { key: "late", header: "Late", className: "text-right", cell: (r) => (r.late_count ? <span className="font-semibold text-warning-text">{r.late_count} ({hmm(r.late_min)})</span> : num(0)) },
        { key: "early", header: "Left early", className: "text-right", cell: (r) => num(r.early_count, true) },
        { key: "ot", header: "Overtime", className: "text-right", cell: (r) => <span className="tabular">{r.overtime_min ? hmm(r.overtime_min) : "—"}</span> },
        { key: "missing", header: "Missing clock-outs", className: "text-right", cell: (r) => num(r.missing, true) },
        { key: "leave", header: "Leave days", className: "text-right", cell: (r) => num(r.leave_days) },
      ]}
      empty={{ title: "No staff match these filters" }}
    />
  );
}
