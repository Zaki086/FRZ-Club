"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PeriodKey, PeriodState } from "./types";

const OPTIONS: Array<{ key: PeriodKey; label: string }> = [
  { key: "TODAY", label: "Today" },
  { key: "WEEK", label: "This week" },
  { key: "MONTH", label: "This month" },
  { key: "CUSTOM", label: "Custom" },
];

export function PeriodPicker({ value, onChange }: { value: PeriodState; onChange: (p: PeriodState) => void }) {
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-muted p-1">
        {OPTIONS.map((o) => (
          <Button
            key={o.key}
            size="sm"
            variant={value.period === o.key ? "default" : "ghost"}
            onClick={() => onChange({ ...value, period: o.key })}
            data-testid={`period-${o.key}`}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {value.period === "CUSTOM" ? (
        <div className="flex items-center gap-1">
          <Input type="date" className="h-8 w-40" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="From" />
          <span className="text-sm text-muted-foreground">to</span>
          <Input type="date" className="h-8 w-40" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="To" />
        </div>
      ) : null}
    </div>
  );
}
