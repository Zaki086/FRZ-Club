"use client";
// v3 §3.2: counter sales with the standard FilterBar — opens on today; a return is taken from the sale's row.
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { StatusBadge } from "@/components/badges";
import { formatINR } from "@/lib/money";
import { ReturnDialog, type Sale } from "../_components/today-sales";
import { FindReceipt } from "./sales-tools";

type Row = {
  id: string; code: string; created_at: string; bill_id: string; member_id: string | null; sold_by_name: string | null; customer: string;
  customer_kind: "member" | "walkin"; bill_customer_kind?: string; total: number; discount: number; refunded: number; status: string; methods: string[]; units: number;
  lines: Sale["lines"];
};

const METHOD: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", ONLINE: "Online", BANK_TRANSFER: "Bank transfer" };
const BILL: Record<string, string> = { PAID: "Paid", PARTIAL: "Part paid", UNPAID: "Unpaid", PARTIALLY_REFUNDED: "Part returned", REFUNDED: "Returned", VOID: "Void" };

function Return({ r }: { r: Row }) {
  const reload = useListReload();
  const sale: Sale = { id: r.id, code: r.code, at: r.created_at, customer: r.customer, total: r.total, discount: r.discount, status: r.status, billId: r.bill_id, methods: r.methods, lines: r.lines };
  return <span onClick={(e) => e.stopPropagation()}><ReturnDialog sale={sale} onDone={reload} /></span>;
}

export function SalesList({ canReturn }: { canReturn: boolean }) {
  return (
    <FilteredList<Row>
      list="sales"
      searchPlaceholder="Sale code, customer or item"
      pollMs={30_000}
      dayStepper
      toolbar={<FindReceipt />}
      columns={[
        { key: "code", header: "Sale", cell: (r) => (
          <span className="flex flex-col">
            <span className="font-mono text-sm font-semibold">{r.code}</span>
            <RelTime when={r.created_at} className="text-xs text-muted-foreground" />
          </span>
        ) },
        { key: "customer", header: "Customer", cell: (r) => (
          <span className="flex flex-col">
            <span className="font-semibold">{r.customer}</span>
            <span className="text-xs text-muted-foreground">{r.customer_kind === "member" ? "Member" : r.bill_customer_kind === "WALK_IN" ? "Walk-in · no phone" : "Walk-in"}</span>
          </span>
        ) },
        { key: "items", header: "Items", cell: (r) => <span className="text-sm">{r.lines.map((l) => `${l.qty}× ${l.description}`).join(", ")}</span> },
        { key: "methods", header: "Paid by", cell: (r) => <span className="text-sm">{r.methods.map((m) => METHOD[m] ?? m).join(" + ") || "—"}</span> },
        { key: "total", header: "Total", className: "text-right", cell: (r) => (
          <span className="flex flex-col items-end">
            <Money paise={r.total} className="font-semibold" />
            {r.discount ? <span className="text-xs text-green-700">−{formatINR(r.discount)}</span> : null}
            {r.refunded ? <span className="text-xs text-muted-foreground">{formatINR(r.refunded)} returned</span> : null}
          </span>
        ) },
        { key: "status", header: "Bill", cell: (r) => <StatusBadge status={r.status} label={BILL[r.status]} /> },
        { key: "staff", header: "Sold by", cell: (r) => <span className="text-sm">{r.sold_by_name ?? "—"}</span> },
        ...(canReturn ? [{ key: "return", header: "", cell: (r: Row) => <Return r={r} /> }] : []),
      ]}
      empty={{ title: "No counter sales match these filters" }}
    />
  );
}
