"use client";
// v3 §3.2: invoices with the standard FilterBar — status (incl. derived overdue), client, type — and a summary strip.
// The old `?status=` and `?clientId=` links are facets of the list. Next action inline: issue a draft, collect a balance.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { FilePlus } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { formatINR } from "@/lib/money";

type Row = {
  id: string; number: string | null; kind: string; status: string; client_id: string | null; customer: string;
  issue_day: string | null; due_day: string | null; created_at: string; total: number; paid: number; due: number; overdue: boolean;
};

const KIND: Record<string, string> = { MEMBERSHIP: "membership", BUSINESS: "business", MEMBER: "member" };

function IssueDraft({ r }: { r: Row }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/invoices/${r.id}`, { body: { action: "issue" } });
            reload();
          } catch (e) {
            setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        Issue invoice
      </Button>
      <RejectionBanner error={error} />
    </span>
  );
}

function NextAction({ r }: { r: Row }) {
  if (r.status === "DRAFT") return <IssueDraft r={r} />;
  if ((r.status === "ISSUED" || r.status === "PARTIALLY_PAID") && r.due > 0) {
    return (
      <Link className="text-sm font-semibold text-primary hover:underline" href={`/app/finance/invoices/${r.id}`}>
        {r.overdue ? "Chase" : "Record payment"} · {formatINR(r.due)}
      </Link>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

function NewInvoice() {
  // Filtered to exactly one client: start the new invoice for that client.
  const clients = useSearchParams().get("clientId")?.split(",").filter(Boolean) ?? [];
  return (
    <Button asChild>
      <Link href={`/app/finance/invoices/new${clients.length === 1 ? `?clientId=${clients[0]}` : ""}`}>
        <FilePlus className="h-4 w-4" /> New invoice
      </Link>
    </Button>
  );
}

export function InvoicesList() {
  return (
    <FilteredList<Row>
      list="invoices"
      searchPlaceholder="Number, customer or note"
      toolbar={<NewInvoice />}
      columns={[
        {
          key: "number",
          header: "Number",
          cell: (r) => (
            <Link className="font-mono text-xs font-semibold text-primary hover:underline" href={`/app/finance/invoices/${r.id}`}>
              {r.number ?? "Draft"}
            </Link>
          ),
        },
        { key: "customer", header: "Customer", cell: (r) => r.customer },
        { key: "kind", header: "Type", cell: (r) => <span className="text-xs">{KIND[r.kind] ?? r.kind.toLowerCase()}</span> },
        { key: "issued", header: "Issued", cell: (r) => <RelTime className="text-sm" when={r.issue_day} /> },
        { key: "due", header: "Due", cell: (r) => <RelTime className={r.overdue ? "text-sm font-semibold text-destructive" : "text-sm"} when={r.due_day} /> },
        { key: "total", header: "Total", className: "text-right", cell: (r) => <Money paise={r.total} /> },
        { key: "balance", header: "Balance", className: "text-right", cell: (r) => <Money paise={r.due} /> },
        {
          key: "status",
          header: "Status",
          cell: (r) => (
            <span className="flex gap-1">
              <StatusBadge status={r.status} />
              {r.overdue ? <StatusBadge status="OVERDUE" /> : null}
            </span>
          ),
        },
        { key: "next", header: "Next", cell: (r) => <NextAction r={r} /> },
      ]}
      empty={{ title: "No invoices match these filters" }}
    />
  );
}
