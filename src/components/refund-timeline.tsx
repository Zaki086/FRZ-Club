"use client";
// v4 §3.4/§3.5: a refund's steps — Requested → Approved (or Not approved) → Ready to collect → Collected.
import { fmtDateTime } from "@/lib/time";

export type TimelineStep = { label: string; at: string | null; detail?: string | null; state: "done" | "current" | "todo" | "stopped" };

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:gap-2" data-testid="refund-timeline">
      {steps.map((s, i) => (
        <li key={s.label} className="flex flex-1 gap-3 sm:flex-col sm:gap-1">
          <div className="flex items-center gap-2 sm:w-full">
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${s.state === "done" ? "bg-success text-white" : s.state === "current" ? "bg-primary text-primary-foreground" : s.state === "stopped" ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"}`}>{i + 1}</span>
            {i < steps.length - 1 ? <span className="hidden h-0.5 flex-1 bg-border sm:block" /> : null}
          </div>
          <div className="pb-3 text-sm">
            <p className={s.state === "todo" ? "text-muted-foreground" : "font-semibold"}>{s.label}</p>
            {s.at ? <p className="text-xs text-muted-foreground">{fmtDateTime(s.at)}</p> : null}
            {s.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

