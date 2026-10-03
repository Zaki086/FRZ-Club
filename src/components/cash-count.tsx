"use client";
// v4 §2.3 / CD-5: count cash by denomination (₹500 … ₹10 notes, ₹20 … ₹1 coins — the denominations are a setting).
// The total shown is the sum of what was typed; the server recomputes it from the same counts.
import { formatINR } from "@/lib/money";
import { Input } from "./ui/input";
import { breakdownCounts, DEFAULT_DENOMINATIONS, type DenominationCount, type Denominations } from "@/lib/cash";

export { DEFAULT_DENOMINATIONS, type DenominationCount, type Denominations };
/** Counts as typed: key `NOTE:50000` / `COIN:2000` → text. */
export type CountDraft = Record<string, string>;

const label = (kind: "NOTE" | "COIN", value: number) => `${formatINR(value)} ${kind === "NOTE" ? "notes" : "coins"}`;

/** The counts typed so far (blank = 0); null when one isn't a whole number. */
export function draftCounts(draft: CountDraft): DenominationCount[] | null {
  const out: DenominationCount[] = [];
  for (const [k, v] of Object.entries(draft)) {
    if (!v.trim()) continue;
    if (!/^\d{1,6}$/.test(v.trim())) return null;
    const [kind, value] = k.split(":");
    out.push({ kind: kind as "NOTE" | "COIN", value: Number(value), count: Number(v.trim()) });
  }
  return out;
}

export function draftTotal(draft: CountDraft): number | null {
  const c = draftCounts(draft);
  return c ? c.reduce((a, x) => a + x.value * x.count, 0) : null;
}

/** A draft filled with the fewest notes and coins that make `paise` (whole rupees). */
export function breakdown(paise: number, d: Denominations = DEFAULT_DENOMINATIONS): CountDraft {
  return Object.fromEntries(breakdownCounts(paise, d).map((c) => [`${c.kind}:${c.value}`, String(c.count)]));
}

export function DenominationGrid({ denominations, value, onChange, testId = "denomination-count" }: { denominations: Denominations; value: CountDraft; onChange: (d: CountDraft) => void; testId?: string }) {
  const total = draftTotal(value);
  const row = (kind: "NOTE" | "COIN", v: number) => {
    const key = `${kind}:${v}`;
    const n = value[key] ?? "";
    const line = /^\d+$/.test(n) ? v * Number(n) : 0;
    return (
      <label key={key} className="flex items-center gap-2 text-sm">
        <span className="w-24 shrink-0 font-medium">{label(kind, v)}</span>
        <Input className="h-8 w-20 text-right tabular" inputMode="numeric" value={n} placeholder="0" aria-label={label(kind, v)} onChange={(e) => onChange({ ...value, [key]: e.target.value.replace(/[^\d]/g, "").slice(0, 6) })} />
        <span className="ml-auto text-xs tabular text-muted-foreground">{line ? formatINR(line) : ""}</span>
      </label>
    );
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</span>
          {denominations.notes.map((v) => row("NOTE", v))}
        </div>
        {denominations.coins.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coins</span>
            {denominations.coins.map((v) => row("COIN", v))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between rounded-xl bg-secondary/60 px-3 py-2 text-sm">
        <span className="font-semibold">Total counted</span>
        <span className="font-display text-lg font-bold tabular" data-testid={`${testId}-total`}>{total === null ? "—" : formatINR(total)}</span>
      </div>
    </div>
  );
}
