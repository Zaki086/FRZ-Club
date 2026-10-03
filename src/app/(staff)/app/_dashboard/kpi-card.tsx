"use client";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatINR } from "@/lib/money";
import { cn } from "@/components/ui/cn";
import type { Kpi } from "./types";

/** Change % always comes from the server; null means there was nothing in the previous period. */
export function ChangeBadge({ change, invert }: { change: number | null; invert?: boolean }) {
  if (change === null) return <span className="rounded bg-junior/10 px-1.5 py-0.5 text-[11px] font-semibold text-junior">new</span>;
  if (change === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
        <Minus className="h-3 w-3" /> 0%
      </span>
    );
  }
  const good = invert ? change < 0 : change > 0;
  const Icon = change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold", good ? "bg-success/10 text-success-text" : "bg-destructive/10 text-destructive")}>
      <Icon className="h-3 w-3" />
      {change > 0 ? "+" : ""}
      {change}%
    </span>
  );
}

export function KpiCard({
  label,
  kpi,
  kind = "money",
  onClick,
  invert,
  hint,
  testId,
}: {
  label: string;
  kpi: Kpi;
  kind?: "money" | "count";
  onClick?: () => void;
  invert?: boolean;
  hint?: string;
  testId?: string;
}) {
  const fmt = (n: number) => (kind === "money" ? formatINR(n) : n.toLocaleString("en-IN"));
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="tabular text-2xl font-bold" data-testid={testId}>{fmt(kpi.value)}</p>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <ChangeBadge change={kpi.change} invert={invert} />
        <span>prev {fmt(kpi.prev)}</span>
      </div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </>
  );
  if (!onClick) return <div className="rounded-lg border bg-card p-3 shadow-sm">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="Click to see the records that add up to this number"
    >
      {body}
    </button>
  );
}

export function StatCard({ label, value, hint, href }: { label: string; value: React.ReactNode; hint?: string; href?: string }) {
  const inner = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="tabular text-2xl font-bold">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </>
  );
  if (href) {
    return (
      <a href={href} className="rounded-lg border bg-card p-3 shadow-sm hover:border-primary">
        {inner}
      </a>
    );
  }
  return <div className="rounded-lg border bg-card p-3 shadow-sm">{inner}</div>;
}
