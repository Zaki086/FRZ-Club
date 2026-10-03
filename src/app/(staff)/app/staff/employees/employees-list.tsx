"use client";
// v3 §4.1: the staff directory with the standard FilterBar. A row opens the employee page.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { FilteredList } from "@/components/list/filtered-list";
import { hmm } from "@/lib/duration";
import { istTime } from "@/lib/time";

type Row = {
  id: string; name: string; phone: string; role: string; status: string; presence: string; clocked_in_since: string | null;
  today_shift: string | null; week_worked_min: number; week_scheduled_min: number; late_month: number; missing_clockouts: number;
  casual_left: number; sick_left: number; drawer_open: boolean; drawer_area: string | null; drawer_expected: number | null;
};

export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", MANAGER: "Manager", FRONT_DESK: "Front desk", SHOP_STAFF: "Shop", BAR_STAFF: "Bar", KITCHEN: "Kitchen", ACCOUNTANT: "Accountant",
};

function Presence({ r }: { r: Row }) {
  if (r.presence === "IN") return <Badge tone="green">Clocked in since {istTime(new Date(r.clocked_in_since!))}</Badge>;
  if (r.presence === "DUE") return <Badge tone="amber">On shift, not clocked in</Badge>;
  return <Badge tone="neutral">Off</Badge>;
}

export function EmployeesList() {
  const router = useRouter();
  return (
    <FilteredList<Row>
      list="employees"
      searchPlaceholder="Name or phone"
      pollMs={60_000}
      onRowClick={(r) => router.push(`/app/staff/employees/${r.id}`)}
      columns={[
        { key: "name", header: "Name", cell: (r) => (
          <span className="flex flex-col">
            <Link className="font-semibold text-primary hover:underline" href={`/app/staff/employees/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            <span className="text-xs text-muted-foreground">{ROLE_LABEL[r.role] ?? r.role}{r.status === "ON_LEAVE" ? " · on leave today" : r.status === "INACTIVE" ? " · inactive" : ""}</span>
          </span>
        ) },
        { key: "now", header: "Now", cell: (r) => <Presence r={r} /> },
        { key: "shift", header: "Today's shift", cell: (r) => r.today_shift ?? <span className="text-muted-foreground">—</span> },
        { key: "week", header: "This week", className: "text-right", cell: (r) => <span className="tabular" title="Worked / scheduled (h:mm)">{hmm(r.week_worked_min)} / {hmm(r.week_scheduled_min)}</span> },
        { key: "late", header: "Late (month)", className: "text-right", cell: (r) => (r.late_month ? <span className="font-semibold text-warning-text">{r.late_month}</span> : <span className="text-muted-foreground">0</span>) },
        { key: "missing", header: "Missing clock-outs", className: "text-right", cell: (r) => (r.missing_clockouts ? <Badge tone="red">{r.missing_clockouts}</Badge> : <span className="text-muted-foreground">0</span>) },
        { key: "leave", header: "Leave left", cell: (r) => <span className="text-sm">{r.casual_left} casual · {r.sick_left} sick</span> },
        { key: "drawer", header: "Cash drawer", className: "text-right", cell: (r) => (r.drawer_open ? <span className="text-sm">Open ({r.drawer_area?.toLowerCase()}) · <Money paise={r.drawer_expected ?? 0} className="font-semibold" /></span> : <span className="text-muted-foreground">—</span>) },
      ]}
      empty={{ title: "No staff match these filters" }}
    />
  );
}
