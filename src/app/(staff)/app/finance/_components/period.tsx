"use client";
import { Input, Select } from "@/components/ui/input";

export type PeriodState = { period: "TODAY" | "WEEK" | "MONTH" | "CUSTOM"; from: string; to: string };

/** Query string for the server's period resolver (DB-1). The server decides the actual date range. */
export function periodQuery(p: PeriodState): string {
  const q = new URLSearchParams({ period: p.period });
  if (p.period === "CUSTOM") {
    q.set("from", p.from);
    q.set("to", p.to);
  }
  return q.toString();
}

export function periodReady(p: PeriodState): boolean {
  return p.period !== "CUSTOM" || (/^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to));
}

export function PeriodPicker({ value, onChange }: { value: PeriodState; onChange: (p: PeriodState) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select className="w-40" value={value.period} onChange={(e) => onChange({ ...value, period: e.target.value as PeriodState["period"] })} aria-label="Period">
        <option value="TODAY">Today</option>
        <option value="WEEK">This week</option>
        <option value="MONTH">This month</option>
        <option value="CUSTOM">Custom</option>
      </Select>
      {value.period === "CUSTOM" ? (
        <>
          <Input className="w-40" type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="From" />
          <span className="text-sm text-muted-foreground">to</span>
          <Input className="w-40" type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="To" />
        </>
      ) : null}
    </div>
  );
}

export function PeriodLabel({ period }: { period?: { label: string; from: string; to: string } }) {
  if (!period) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {period.label}: {period.from} → {period.to} (IST)
    </p>
  );
}
