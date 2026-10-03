"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/time";

type Row = { id: string; at: string; actorLabel: string; action: string; entity: string; entityId: string; reason: string | null; before: unknown; after: unknown };

const ENTITIES = [
  "", "booking", "court_reservation", "member", "membership", "payment", "bill", "invoice", "shop_order", "counter_sale", "product_variant",
  "tab", "tab_line", "kitchen_ticket", "bar_day", "lead", "quote", "shift", "leave_request", "attendance", "payroll_run", "expense_bill",
  "setting", "plan", "court", "user", "share_link", "social_session", "social_participant", "service_ticket", "visit",
];
const PAGE = 100;

export function AuditViewer() {
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [extra, setExtra] = useState<Row[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const qs = new URLSearchParams({ limit: String(PAGE) });
  if (entity) qs.set("entity", entity);
  if (action.trim()) qs.set("action", action.trim());
  if (search.trim()) qs.set("search", search.trim());
  const state = useApi<Row[]>(`/api/audit?${qs.toString()}`);
  const resetPaging = () => {
    setExtra([]);
    setMore(true);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Select className="w-56" value={entity} onChange={(e) => { setEntity(e.target.value); resetPaging(); }} aria-label="Entity">
          {ENTITIES.map((e) => <option key={e} value={e}>{e ? e.replace(/_/g, " ") : "All entities"}</option>)}
        </Select>
        <Input className="w-56" placeholder="Action contains… (e.g. refund, cancel)" value={action} onChange={(e) => { setAction(e.target.value); resetPaging(); }} />
        <Input className="w-56" placeholder="Actor name or role…" value={search} onChange={(e) => { setSearch(e.target.value); resetPaging(); }} />
      </div>
      <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No audit entries match", hint: "Try a different filter." }}>
        {(first) => {
          const rows = [...first, ...extra];
          return (
            <div className="flex flex-col gap-2">
              <Card className="divide-y">
                {rows.map((r) => <AuditRow key={r.id} row={r} />)}
              </Card>
              <RejectionBanner error={error} />
              {more && first.length >= PAGE ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const q = new URLSearchParams(qs);
                      q.set("before", rows[rows.length - 1].at);
                      const next = await api<Row[]>(`/api/audit?${q.toString()}`);
                      setExtra([...extra, ...next]);
                      if (next.length < PAGE) setMore(false);
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Loading…" : "Load more"}
                </Button>
              ) : (
                <p className="text-center text-xs text-muted-foreground">{rows.length} entr{rows.length === 1 ? "y" : "ies"} shown — end of log for this filter.</p>
              )}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

function AuditRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="p-3 text-sm">
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(row.at)}</span>
        <span className="font-mono text-xs font-semibold">{row.action}</span>
        <span className="text-xs">{row.entity.replace(/_/g, " ")} <span className="font-mono text-muted-foreground">{row.entityId.slice(-10)}</span></span>
        <span className="ml-auto text-xs">{row.actorLabel}</span>
      </button>
      {row.reason ? <p className="ml-7 mt-1 text-xs">Reason: {row.reason}</p> : null}
      {open ? (
        <div className="ml-7 mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Before</p>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{row.before === null || row.before === undefined ? "—" : JSON.stringify(row.before, null, 2)}</pre>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">After</p>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{row.after === null || row.after === undefined ? "—" : JSON.stringify(row.after, null, 2)}</pre>
          </div>
          <p className="text-[11px] text-muted-foreground md:col-span-2">Entity id: <span className="font-mono">{row.entityId}</span></p>
        </div>
      ) : null}
    </div>
  );
}
