"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/components/api";
import type { PlayerInput, Quote } from "./types";

/** PR-9 live preview: the server prices every player; confirming recomputes on the server anyway. */
export function useBookingQuote(courtId: string | null, date: string, startTime: string | null, players: PlayerInput[]) {
  const key = courtId && startTime && players.length ? JSON.stringify({ courtId, date, startTime, players }) : null;
  const [state, setState] = useState<{ key: string; data?: Quote; error?: { code?: string; message: string } } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const req = JSON.parse(key) as { courtId: string; date: string; startTime: string; players: PlayerInput[] };
    api<Quote>("/api/bookings/quote", { body: req })
      .then((d) => {
        if (!cancelled) setState({ key, data: d });
      })
      .catch((e) => {
        if (!cancelled) setState({ key, error: e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) } });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  const current = key && state?.key === key ? state : null;
  return { quote: current?.data, error: current?.error ?? null, loading: !!key && !current };
}
