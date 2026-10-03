"use client";
// v3 §3.2: every bar tab with the standard FilterBar and summary strip. The next action is on the row: open the tab
// (order, send, settle), settle a carried-over tab, or — for a Manager — carry an open tab over with a reason (BR-9).
import Link from "next/link";
import { api } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { ConfirmButton } from "@/components/confirm";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/time";

type Row = {
  id: string; code: string; status: string; table_number: number | null; payer: string; phone: string | null; member_code: string | null;
  who: "member" | "guest"; tier: string; total: number; discount: number; paid: number; due: number; bar_day: string; opened_at: string;
  settled_at: string | null; carried_reason: string | null; opened_by_name: string | null; carried_by_name: string | null;
  guest_id_verified: boolean; items: number; summary: string | null;
};
type Perms = { operate: boolean; carry: boolean };

const STATUS_LABEL: Record<string, string> = { OPEN: "Open", CARRIED: "Carried over", SETTLED: "Settled", VOID: "Void" };

function CarryOver({ r }: { r: Row }) {
  const reload = useListReload();
  return (
    <ConfirmButton
      trigger="Carry over"
      size="sm"
      title={`Carry tab ${r.code} over?`}
      description="The tab stays payable later; the reason is audited (BR-9)."
      requireReason
      variant="outline"
      confirmLabel="Carry over"
      onConfirm={async (reason) => {
        await api(`/api/bar/tabs/${r.id}/carry`, { body: { reason } });
        reload();
      }}
    />
  );
}

function NextAction({ r, perms }: { r: Row; perms: Perms }) {
  if (r.status !== "OPEN" && r.status !== "CARRIED") return null;
  return (
    <span className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      {perms.operate ? (
        <Button asChild size="sm" variant={r.status === "CARRIED" ? "default" : "outline"}>
          <Link href={`/app/bar/tabs/${r.id}`}>{r.status === "CARRIED" ? "Settle" : "Open tab"}</Link>
        </Button>
      ) : null}
      {r.status === "OPEN" && perms.carry ? <CarryOver r={r} /> : null}
    </span>
  );
}

export function TabsList({ perms }: { perms: Perms }) {
  return (
    <FilteredList<Row>
      list="tabs"
      searchPlaceholder="TAB code, name, phone or member code"
      pollMs={20_000}
      columns={[
        { key: "code", header: "Tab", cell: (r) => (
          <span className="flex flex-col">
            <span className="font-mono text-sm font-semibold">{r.code}</span>
            <RelTime when={r.opened_at} className="text-xs text-muted-foreground" />
          </span>
        ) },
        { key: "payer", header: "Payer", cell: (r) => (
          <span className="flex flex-col items-start gap-0.5">
            <span className="font-semibold">{r.payer}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">{r.who === "member" ? r.member_code ?? "Member" : "Guest"} <TierBadge tier={r.tier} /></span>
          </span>
        ) },
        { key: "table", header: "Table", cell: (r) => (r.table_number === null ? <span className="text-muted-foreground">Counter</span> : <span>Table {r.table_number}</span>) },
        { key: "day", header: "Bar day", cell: (r) => <RelTime when={r.bar_day} className="text-sm" /> },
        { key: "total", header: "Total", className: "text-right", cell: (r) => <Money paise={r.total} /> },
        { key: "due", header: "Due", className: "text-right", cell: (r) => (r.due > 0 ? <Money paise={r.due} className="font-semibold" /> : <span className="text-muted-foreground">—</span>) },
        { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /> },
        { key: "next", header: "Next", cell: (r) => <NextAction r={r} perms={perms} /> },
      ]}
      rowExtra={(r) => (
        <div className="grid gap-1 text-sm sm:grid-cols-2">
          <span>{r.items ? `${r.items} item${r.items === 1 ? "" : "s"}: ${r.summary}` : "No items on this tab."}</span>
          <span className="text-muted-foreground">
            Opened {fmtDateTime(r.opened_at)}{r.opened_by_name ? ` by ${r.opened_by_name}` : ""}
            {r.paid ? <> · paid <Money paise={r.paid} /></> : null}
            {r.discount ? <> · discounts <Money paise={r.discount} /></> : null}
            {r.settled_at ? ` · settled ${fmtDateTime(r.settled_at)}` : ""}
            {r.who === "guest" && r.guest_id_verified ? " · ID verified 18+" : ""}
          </span>
          {r.carried_reason ? <span className="sm:col-span-2">Carried over{r.carried_by_name ? ` by ${r.carried_by_name}` : ""}: “{r.carried_reason}”</span> : null}
        </div>
      )}
      empty={{ title: "No tabs match these filters", hint: "Open a tab from the tables screen." }}
    />
  );
}
