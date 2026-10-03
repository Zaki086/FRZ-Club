"use client";
// v3 §3.2: the message log with the standard FilterBar (opens on the last 7 days). A row opens to show the full text.
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";

type Row = { id: string; channel: string; recipient: string; subject: string; body: string; status: string; error: string | null; entity: string | null; at: string; actor_name: string | null };

export function MessageLogView() {
  return (
    <FilteredList<Row>
      list="messages"
      searchPlaceholder="Search recipient or text"
      columns={[
        { key: "at", header: "When", cell: (r) => <RelTime when={r.at} className="whitespace-nowrap text-xs" /> },
        { key: "channel", header: "Channel", cell: (r) => (r.channel === "WHATSAPP" ? "WhatsApp" : "Email") },
        { key: "to", header: "To", cell: (r) => <span className="font-mono text-xs">{r.recipient}</span> },
        {
          key: "message", header: "Message", className: "max-w-md", cell: (r) => (
            <span className="text-xs">
              {r.subject ? <strong className="block">{r.subject}</strong> : null}
              <span className="line-clamp-2">{r.body}</span>
              {r.error ? <span className="block text-red-700">{r.error}</span> : null}
            </span>
          ),
        },
        { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "SENT" ? "green" : r.status === "FAILED" ? "red" : "neutral"}>{r.status.toLowerCase()}</Badge> },
        { key: "by", header: "By", cell: (r) => <span className="text-xs">{r.actor_name ?? "system"}</span> },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          {r.subject ? <p className="font-semibold">{r.subject}</p> : null}
          <p className="whitespace-pre-wrap text-xs">{r.body}</p>
          {r.error ? <p className="text-xs text-red-700">Error: {r.error}</p> : null}
          {r.entity ? <p className="text-[11px] text-muted-foreground">About: {r.entity.replace(/_/g, " ")}</p> : null}
        </div>
      )}
      empty={{ title: "No messages for these filters", hint: "Widen the dates or remove a filter." }}
    />
  );
}
