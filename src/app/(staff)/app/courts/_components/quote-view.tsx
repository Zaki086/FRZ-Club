import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import type { Quote } from "./types";

export function QuoteView({ quote, loading }: { quote?: Quote; loading?: boolean }) {
  if (loading && !quote) return <p className="text-sm text-muted-foreground">Pricing…</p>;
  if (!quote) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="booking-quote">
      {quote.players.map((p, i) => (
        <div key={i} className="flex items-start justify-between gap-2 py-1">
          <div>
            <p className="font-medium">
              {p.name} <TierBadge tier={p.tier} />
            </p>
            <p className="text-xs text-muted-foreground">{p.explanation}</p>
          </div>
          <Money paise={p.fee} className="font-medium" />
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t pt-2 text-base font-semibold">
        <span>Total (GST incl.)</span>
        <Money paise={quote.total} />
      </div>
    </div>
  );
}
