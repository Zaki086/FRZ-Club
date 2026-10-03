import { fmtDateTime } from "@/lib/time";
import { STATUS_LABEL } from "./types";

export function OrderTimeline({ events }: { events: Array<{ status: string; at: string; note: string | null }> }) {
  return (
    <ol className="flex flex-col gap-1 border-l-2 border-primary/30 pl-3 text-xs">
      {events.map((e, i) => (
        <li key={i}>
          <span className="font-semibold">{STATUS_LABEL[e.status] ?? e.status}</span> · {fmtDateTime(e.at)}
          {e.note ? <span className="text-muted-foreground"> — {e.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}
