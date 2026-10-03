"use client";
// PR-9 live preview for members. The server recomputes every price when the booking is confirmed.
import { useEffect, useState } from "react";
import { api, ApiError } from "@/components/api";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";

export type PortalPlayerInput = { memberId: string } | { memberCode: string } | { guest: { name: string } };
export type PortalQuote = { total: number; players: Array<{ name: string; tier: string; fee: number; explanation: string }> };

export function usePortalQuote(courtId: string | null, date: string, startTime: string | null, players: PortalPlayerInput[]) {
  const key = courtId && startTime && players.length ? JSON.stringify({ courtId, date, startTime, players }) : null;
  const [state, setState] = useState<{ key: string; data?: PortalQuote; error?: { code?: string; message: string } } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api<PortalQuote>("/api/bookings/quote", { body: JSON.parse(key) })
      .then((d) => { if (!cancelled) setState({ key, data: d }); })
      .catch((e) => { if (!cancelled) setState({ key, error: e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) } }); });
    return () => { cancelled = true; };
  }, [key]);
  const cur = key && state?.key === key ? state : null;
  return { quote: cur?.data, error: cur?.error ?? null, loading: !!key && !cur };
}

export function PortalQuoteView({ quote, loading }: { quote?: PortalQuote; loading: boolean }) {
  if (loading && !quote) return <p className="text-sm text-muted-foreground">Pricing…</p>;
  if (!quote) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="portal-quote">
      {quote.players.map((p, i) => (
        <div key={i} className="flex items-start justify-between gap-2 py-1">
          <div>
            <p className="font-medium">{p.name} <TierBadge tier={p.tier} /></p>
            <p className="text-xs text-muted-foreground">{p.explanation}</p>
          </div>
          <Money paise={p.fee} />
        </div>
      ))}
      <p className="mt-1 flex justify-between border-t pt-2 font-semibold"><span>You pay</span><Money paise={quote.total} /></p>
    </div>
  );
}
