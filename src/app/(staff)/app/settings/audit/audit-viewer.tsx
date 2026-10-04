"use client";
// v3 §3.2: the audit log with the standard FilterBar (opens on the last 7 days). A row opens in place to show the
// before/after snapshots, loaded only for that entry.
import { useApi } from "@/components/api";
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { DataState } from "@/components/states";

type Row = { id: string; at: string; actor_id: string | null; actor_label: string; action: string; entity: string; entity_id: string; reason: string | null };
type Entry = { id: string; before: unknown; after: unknown };

function Snapshots({ row }: { row: Row }) {
  // The entry and the ones just before it for the same record; `before` is exclusive, so ask from 1 ms later.
  const before = new Date(new Date(row.at).getTime() + 1).toISOString();
  const state = useApi<Entry[]>(`/api/audit?${new URLSearchParams({ entity: row.entity, entityId: row.entity_id, before, limit: "20" }).toString()}`);
  return (
    <DataState state={state}>
      {(entries) => {
        const e = entries.find((x) => x.id === row.id);
        return (
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Before</p>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{e?.before === null || e?.before === undefined ? "—" : JSON.stringify(e.before, null, 2)}</pre>
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground">After</p>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{e?.after === null || e?.after === undefined ? "—" : JSON.stringify(e.after, null, 2)}</pre>
            </div>
            <p className="text-[11px] text-muted-foreground md:col-span-2">Entity id: <span className="font-mono">{row.entity_id}</span></p>
          </div>
        );
      }}
    </DataState>
  );
}

export function AuditViewer() {
  return (
    <FilteredList<Row>
      list="audit"
      searchPlaceholder="Action, entity, id, person or reason"
      columns={[
        { key: "at", header: "When", cell: (r) => <RelTime when={r.at} className="whitespace-nowrap text-xs" /> },
        { key: "action", header: "Action", cell: (r) => <span className="font-mono text-xs font-semibold">{r.action}</span> },
        {
          key: "entity", header: "Record", cell: (r) => (
            <span className="text-xs">{r.entity.replace(/_/g, " ")} <span className="font-mono text-muted-foreground">{r.entity_id.slice(-10)}</span></span>
          ),
        },
        { key: "who", header: "Who", cell: (r) => <span className="text-xs">{r.actor_label}</span> },
        { key: "reason", header: "Reason", className: "max-w-xs", cell: (r) => (r.reason ? <span className="line-clamp-2 text-xs">{r.reason}</span> : <span className="text-xs text-muted-foreground">—</span>) },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-2 text-sm">
          {r.reason ? <p className="text-xs">Reason: {r.reason}</p> : null}
          <Snapshots row={r} />
        </div>
      )}
      empty={{ title: "No audit entries match" }}
    />
  );
}
