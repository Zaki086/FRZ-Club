"use client";
// v3 §3.2: the ledger with the standard FilterBar — date (IST presets), source, method, direction — and a summary strip
// (money in, money out, net). The list's CSV is the ledger export; the Tally day book follows the same filters.
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { FilteredList } from "@/components/list/filtered-list";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";

type Row = {
  id: string; occurred_at: string; source: string; direction: string; method: string; description: string; amount: number; tax_amount: number;
  customer: string | null;
};

const SOURCE: Record<string, string> = {
  COURTS: "Courts", SOCIAL: "Social play", SHOP: "Shop", BAR: "Bar & cafe", MEMBERSHIP: "Membership", INVOICE: "Invoices", EXPENSE: "Expenses", PAYROLL: "Payroll",
};

/** Tally day book for exactly what the list shows (dates, source, method, direction, search). */
function TallyLink() {
  const sp = useSearchParams();
  // No parameters yet: the list opens on today (its default).
  const q = new URLSearchParams({ report: "tally", range: sp.get("range") ?? (sp.toString() ? "ALL" : "TODAY") });
  for (const k of ["from", "to", "source", "method", "direction", "q"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  return (
    <Button asChild variant="outline" size="sm">
      <a href={`/api/reports/csv?${q.toString()}`}><Download className="h-4 w-4" /> Tally day book</a>
    </Button>
  );
}

export function LedgerExplorer() {
  return (
    <FilteredList<Row>
      list="ledger"
      searchPlaceholder="Description"
      dayStepper
      toolbar={<TallyLink />}
      columns={[
        { key: "when", header: "When (IST)", cell: (r) => <RelTime className="whitespace-nowrap text-xs" when={r.occurred_at} /> },
        { key: "source", header: "Source", cell: (r) => <Badge tone="neutral">{SOURCE[r.source] ?? r.source}</Badge> },
        { key: "direction", header: "Dir.", cell: (r) => <Badge tone={r.direction === "IN" ? (r.amount < 0 ? "amber" : "green") : "red"}>{r.direction}</Badge> },
        { key: "method", header: "Method", cell: (r) => <span className="text-xs">{r.method.replace(/_/g, " ")}</span> },
        { key: "description", header: "Description", cell: (r) => <span className="text-sm">{r.description}{r.customer ? <span className="block text-xs text-muted-foreground">{r.customer}</span> : null}</span> },
        { key: "amount", header: "Amount", className: "text-right", cell: (r) => <span className="flex flex-col items-end"><Money paise={r.amount} />{r.direction === "IN" && r.amount < 0 ? <span className="text-xs text-muted-foreground">refund</span> : null}</span> },
        { key: "tax", header: "Tax", className: "text-right text-xs", cell: (r) => <Money paise={r.tax_amount} /> },
      ]}
      empty={{ title: "No ledger entries" }}
    />
  );
}
