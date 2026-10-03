"use client";
// v3 §5.1 / v4 §2: all drawer sessions (Owner, Manager, Accountant) with the standard FilterBar — staff, till, status,
// date, variance ≠ 0. A row opens the session with its movements.
import { useRouter } from "next/navigation";
import { FilteredList } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime, fmtRange } from "@/lib/time";

type Row = {
  id: string; name: string; area: string; drawer_name: string; status: string; opened_at: string; closed_at: string | null; opening_float: number; cash_in: number; cash_out: number;
  upi: number; card: number; online: number; cash_expected: number; cash_counted: number | null; variance: number | null; state: string; note: string | null;
};

export const SESSION_STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "blue" | "neutral" }> = {
  OPEN: { label: "Open", tone: "blue" },
  PENDING_APPROVAL: { label: "Awaiting approval", tone: "amber" },
  CLOSED: { label: "Closed", tone: "neutral" },
  APPROVED: { label: "Variance approved", tone: "green" },
  REJECTED: { label: "Variance rejected", tone: "red" },
};

export function DrawersList() {
  const router = useRouter();
  return (
    <FilteredList<Row>
      list="drawers"
      searchPlaceholder="Staff or till"
      pollMs={30_000}
      onRowClick={(r) => router.push(`/app/finance/drawers/${r.id}`)}
      columns={[
        { key: "who", header: "Staff", cell: (r) => <span className="flex flex-col"><span className="font-semibold">{r.name}</span><span className="text-xs text-muted-foreground">{r.drawer_name}</span></span> },
        { key: "when", header: "Session", cell: (r) => (r.closed_at ? <span className="text-sm">{fmtDateTime(r.opened_at)} · {fmtRange(r.opened_at, r.closed_at)}</span> : <Badge tone="blue">Open since {fmtDateTime(r.opened_at)}</Badge>) },
        { key: "status", header: "Status", cell: (r) => <Badge tone={SESSION_STATUS[r.status]?.tone ?? "neutral"}>{SESSION_STATUS[r.status]?.label ?? r.status}</Badge> },
        { key: "collected", header: "Collected", className: "text-right", cell: (r) => <Money paise={r.cash_in + r.upi + r.card + r.online} /> },
        { key: "expected", header: "Cash expected", className: "text-right", cell: (r) => <Money paise={r.cash_expected} /> },
        { key: "counted", header: "Counted", className: "text-right", cell: (r) => (r.cash_counted === null ? <span className="text-muted-foreground">—</span> : <Money paise={r.cash_counted} />) },
        { key: "variance", header: "Variance", className: "text-right", cell: (r) => (r.variance === null ? <span className="text-muted-foreground">—</span> : r.variance === 0 ? <Badge tone="green">None</Badge> : <Badge tone="red">{r.variance > 0 ? "Over" : "Short"} <Money paise={Math.abs(r.variance)} /></Badge>) },
      ]}
      empty={{ title: "No drawer sessions match these filters" }}
    />
  );
}
