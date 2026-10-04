"use client";
// v3 §3.2: the stock movement log (SH-3) with the standard FilterBar.
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { categoryLabel } from "@/components/shop-quote";
import { formatINR } from "@/lib/money";

type Row = {
  id: string; created_at: string; reason: string; on_hand_delta: number; reserved_delta: number; ref_type: string | null; ref_code: string | null;
  unit_cost: number | null; note: string | null; actor_name: string | null; sku: string; label: string; product: string; category: string;
};

const TYPE: Record<string, { label: string; tone: "green" | "amber" | "blue" | "red" | "neutral" }> = {
  RECEIPT: { label: "Received", tone: "green" }, COUNTER_SALE: { label: "Counter sale", tone: "blue" }, RESERVE: { label: "Reserved (online)", tone: "amber" },
  RELEASE: { label: "Released (online)", tone: "neutral" }, ONLINE_FULFIL: { label: "Handed over (online)", tone: "blue" }, ADJUSTMENT: { label: "Adjustment", tone: "red" },
  RETURN: { label: "Returned", tone: "green" },
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function MovementsList() {
  return (
    <FilteredList<Row>
      list="movements"
      searchPlaceholder="Product, SKU, note or sale / order code"
      columns={[
        { key: "when", header: "When", cell: (m) => <RelTime when={m.created_at} className="text-sm" /> },
        { key: "product", header: "Product", cell: (m) => (
          <span className="flex flex-col">
            <span className="font-semibold">{m.product}{m.label !== "Standard" ? <span className="font-normal text-muted-foreground"> · {m.label}</span> : null}</span>
            <span className="font-mono text-xs text-muted-foreground">{m.sku} · {categoryLabel(m.category)}</span>
          </span>
        ) },
        { key: "type", header: "Movement", cell: (m) => <Badge tone={TYPE[m.reason]?.tone ?? "neutral"}>{TYPE[m.reason]?.label ?? m.reason}</Badge> },
        { key: "onhand", header: "On hand", className: "text-right", cell: (m) => <span className="tabular">{m.on_hand_delta ? signed(m.on_hand_delta) : "—"}</span> },
        { key: "reserved", header: "Reserved", className: "text-right", cell: (m) => <span className="tabular">{m.reserved_delta ? signed(m.reserved_delta) : "—"}</span> },
        { key: "ref", header: "Reference", cell: (m) => (
          <span className="text-xs">
            {m.ref_code ? <span className="font-mono">{m.ref_code} </span> : null}
            {m.note ?? ""}
            {m.unit_cost ? ` @ ${formatINR(m.unit_cost)}` : ""}
          </span>
        ) },
        { key: "by", header: "By", cell: (m) => <span className="text-sm">{m.actor_name ?? "System / online"}</span> },
      ]}
      empty={{ title: "No stock movements match these filters" }}
    />
  );
}
