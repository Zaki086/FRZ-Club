"use client";
// v3 §3.2: check-ins (visits) with the standard FilterBar, today by default. The next action is on the row:
// check a member out — warned first when they still have an open bar tab (CI-4 / E-13).
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/time";

type Row = {
  id: string; checked_in_at: string; checked_out_at: string | null; member_id: string | null; guest_id: string | null; booking_id: string | null;
  name: string; phone: string | null; member_code: string | null; who: "member" | "guest"; kind: string; what: string | null; tier: string;
  by_user_id: string | null; by_name: string | null; state: "IN" | "OUT" | "NO_CHECKOUT"; open_tab_code: string | null;
};

const KIND_LABEL: Record<string, string> = { BOOKING: "Court booking", SOCIAL: "Social play", OTHER: "Other" };

function CheckOut({ r }: { r: Row }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [openTab, setOpenTab] = useState<{ code: string; due: number } | null>(null);
  const run = async (acknowledgeOpenTab: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ checkedOut: boolean; openTab: { id: string; code: string; due: number } | null }>("/api/checkout", { body: { memberId: r.member_id, acknowledgeOpenTab } });
      if (res.checkedOut) reload();
      else setOpenTab(res.openTab);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col items-start gap-1" onClick={(e) => e.stopPropagation()}>
      {openTab ? (
        <>
          <span className="text-xs font-semibold text-amber-700">Open bar tab {openTab.code} · <Money paise={openTab.due} /> due</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(true)}>Check out anyway</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(false)}>Check out</Button>
      )}
      <RejectionBanner error={error} />
    </span>
  );
}

export function VisitsList() {
  return (
    <FilteredList<Row>
      list="visits"
      searchPlaceholder="Name, phone, member code or booking"
      pollMs={30_000}
      dayStepper
      columns={[
        { key: "when", header: "Checked in", cell: (r) => <RelTime when={r.checked_in_at} className="text-sm font-semibold" /> },
        { key: "name", header: "Name", cell: (r) => (
          <span className="flex flex-col items-start gap-0.5">
            <span className="font-semibold">{r.name}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">{r.who === "member" ? r.member_code ?? "Member" : "Guest"} {r.who === "member" ? <TierBadge tier={r.tier} /> : null}</span>
          </span>
        ) },
        { key: "for", header: "For", cell: (r) => (
          <span className="flex flex-col">
            <span className="text-sm">{KIND_LABEL[r.kind] ?? r.kind}</span>
            {r.what ? <span className="font-mono text-xs text-muted-foreground">{r.what}</span> : null}
          </span>
        ) },
        { key: "by", header: "By", cell: (r) => <span className="text-sm">{r.by_name ?? "—"}</span> },
        { key: "out", header: "Checked out", cell: (r) => (r.checked_out_at ? <RelTime when={r.checked_out_at} className="text-sm" /> : r.state === "IN" ? <Badge tone="blue">Here now</Badge> : <span className="text-muted-foreground">—</span>) },
        { key: "next", header: "Next", cell: (r) => (r.who === "member" && r.state === "IN" && r.member_id ? <CheckOut r={r} /> : null) },
      ]}
      rowExtra={(r) => (
        <p className="text-sm text-muted-foreground">
          Checked in {fmtDateTime(r.checked_in_at)}{r.by_name ? ` by ${r.by_name}` : ""}
          {r.checked_out_at ? ` · checked out ${fmtDateTime(r.checked_out_at)}` : ""}
          {r.phone ? ` · ${r.phone}` : ""}
          {r.open_tab_code && r.state === "IN" ? ` · open bar tab ${r.open_tab_code}` : ""}
        </p>
      )}
      empty={{ title: "No check-ins match these filters" }}
    />
  );
}
