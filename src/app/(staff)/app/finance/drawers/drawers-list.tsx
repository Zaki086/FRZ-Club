"use client";
// v3 §5.1: all drawer sessions (Owner, Manager, Accountant) with the standard FilterBar — staff, date, variance ≠ 0.
import { FilteredList } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime, fmtRange } from "@/lib/time";
import { DrawerBreakdown } from "@/components/drawer-breakdown";

type Row = {
  id: string; name: string; area: string; opened_at: string; closed_at: string | null; opening_float: number; cash_in: number; cash_out: number;
  upi: number; card: number; online: number; cash_n: number; upi_n: number; card_n: number; online_n: number; upi_out: number; card_out: number; online_out: number; cash_expected: number; cash_counted: number | null; variance: number | null; state: string; note: string | null;
};

export function DrawersList() {
  return (
    <FilteredList<Row>
      list="drawers"
      searchPlaceholder="Staff name"
      pollMs={30_000}
      columns={[
        { key: "who", header: "Staff", cell: (r) => <span className="flex flex-col"><span className="font-semibold">{r.name}</span><span className="text-xs text-muted-foreground">{r.area.toLowerCase()} drawer</span></span> },
        { key: "when", header: "Session", cell: (r) => (r.closed_at ? <span className="text-sm">{fmtDateTime(r.opened_at)} · {fmtRange(r.opened_at, r.closed_at)}</span> : <Badge tone="blue">Open since {fmtDateTime(r.opened_at)}</Badge>) },
        { key: "collected", header: "Collected", className: "text-right", cell: (r) => <Money paise={r.cash_in + r.upi + r.card + r.online} /> },
        { key: "expected", header: "Cash expected", className: "text-right", cell: (r) => <Money paise={r.cash_expected} /> },
        { key: "counted", header: "Counted", className: "text-right", cell: (r) => (r.cash_counted === null ? <span className="text-muted-foreground">—</span> : <Money paise={r.cash_counted} />) },
        { key: "variance", header: "Variance", className: "text-right", cell: (r) => (r.variance === null ? <span className="text-muted-foreground">—</span> : r.variance === 0 ? <Badge tone="green">None</Badge> : <Badge tone="red">{r.variance > 0 ? "Over" : "Short"} <Money paise={Math.abs(r.variance)} /></Badge>) },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-2">
          <DrawerBreakdown
            sessionId={r.id}
            total={r.cash_in + r.upi + r.card + r.online}
            collections={[
              { method: "CASH", count: r.cash_n, amount: r.cash_in, refundCount: 0, refunded: r.cash_out },
              { method: "UPI", count: r.upi_n, amount: r.upi, refundCount: 0, refunded: r.upi_out },
              { method: "CARD", count: r.card_n, amount: r.card, refundCount: 0, refunded: r.card_out },
              { method: "ONLINE", count: r.online_n, amount: r.online, refundCount: 0, refunded: r.online_out },
            ]}
          />
          {r.note ? <p className="text-sm text-muted-foreground">Note: {r.note}</p> : null}
        </div>
      )}
      empty={{ title: "No drawer sessions match these filters" }}
    />
  );
}
