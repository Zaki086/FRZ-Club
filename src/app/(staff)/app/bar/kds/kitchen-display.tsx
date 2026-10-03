"use client";
// E-11 / BR-6: kitchen display. Polls every 4 s. Shows table and who ordered, so the kitchen never has to ask.
import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Maximize2 } from "lucide-react";
import { api, useApi } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { istTime } from "@/lib/time";
import { toRejection, type Rejection } from "../_components/err";

type Ticket = {
  ticketId: string; sentAt: string; ageMinutes: number; table: number | null; tabCode: string; payer: string;
  lines: Array<{ id: string; name: string; qty: number; note: string | null; status: "NEW" | "PREPARING" | "READY" }>;
};

/** Completion pass §7 (kitchen): a short two-tone beep for every new ticket, when sound is on. */
function beep(ctx: AudioContext) {
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.18);
    osc.stop(ctx.currentTime + i * 0.18 + 0.17);
  }
}

function useTicketSound(tickets: Ticket[] | undefined) {
  // Sound always starts off: browsers block audio until the kitchen taps the button on this screen.
  const [on, setOn] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!tickets) return;
    const ids = new Set(tickets.map((t) => t.ticketId));
    const fresh = seen.current ? [...ids].some((id) => !seen.current!.has(id)) : false;
    seen.current = ids;
    if (fresh && on && ctx.current) beep(ctx.current);
  }, [tickets, on]);
  const toggle = () => {
    const next = !on;
    if (next) {
      // Browsers only allow sound after a tap: create/resume the audio context here.
      ctx.current ??= new AudioContext();
      void ctx.current.resume();
      beep(ctx.current);
    }
    setOn(next);
  };
  return { on, toggle };
}

export function KitchenDisplay() {
  const state = useApi<Ticket[]>("/api/bar/kds", { pollMs: 4000 });
  const sound = useTicketSound(state.data);
  const [error, setError] = useState<Rejection>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const advance = async (lineId: string, status: "PREPARING" | "READY") => {
    setBusy(lineId);
    setError(null);
    try {
      await api(`/api/bar/lines/${lineId}/status`, { body: { status } });
      await state.reload();
    } catch (e) {
      setError(toRejection(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="-m-4 min-h-[calc(100vh-3.5rem)] bg-ink p-4 text-ink-foreground lg:-m-6 lg:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-black tracking-tight">Kitchen display</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {state.error ? <span className="text-destructive-foreground">Connection problem: {state.error.message}</span> : <span>Live · refreshes every 4 s</span>}
          <Button size="sm" variant="secondary" onClick={sound.toggle} aria-pressed={sound.on} data-testid="kds-sound">
            {sound.on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />} {sound.on ? "Sound on" : "Sound off"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => document.documentElement.requestFullscreen?.().catch(() => setError({ message: "Full screen is not available in this browser." }))}>
            <Maximize2 className="h-4 w-4" /> Full screen
          </Button>
        </div>
      </div>
      <RejectionBanner error={error} />
      {state.data === undefined && !state.error ? (
        <p className="py-20 text-center text-xl text-muted-foreground">Loading tickets…</p>
      ) : state.data && state.data.length === 0 ? (
        <p className="py-20 text-center text-2xl text-muted-foreground">No open tickets. 👍</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {(state.data ?? []).map((t) => (
            <div
              key={t.ticketId}
              className={cn(
                "flex flex-col rounded-2xl border-4 bg-white/5",
                t.ageMinutes > 20 ? "border-destructive" : t.ageMinutes > 10 ? "border-warning" : "border-white/15",
              )}
              data-testid="kds-ticket"
            >
              <div className="flex items-start justify-between gap-2 border-b border-white/15 p-3">
                <div>
                  <p className="text-3xl font-black leading-none">{t.table ? `Table ${t.table}` : "Counter"}</p>
                  <p className="mt-1 text-xl font-semibold text-accent">{t.payer}</p>
                  <p className="font-mono text-xs text-muted-foreground">{t.tabCode} · sent {istTime(new Date(t.sentAt))}</p>
                </div>
                <span className={cn("rounded-lg px-3 py-1 text-2xl font-black tabular", t.ageMinutes > 20 ? "bg-destructive text-destructive-foreground" : t.ageMinutes > 10 ? "bg-warning text-warning-foreground" : "bg-white/10")}>
                  {t.ageMinutes}′
                </span>
              </div>
              <div className="flex flex-col divide-y divide-white/10">
                {t.lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="text-xl font-bold">
                        <span className="text-accent">{l.qty}×</span> {l.name}
                      </p>
                      {l.note ? <p className="text-base font-semibold text-warning">⚠ {l.note}</p> : null}
                    </div>
                    {l.status === "NEW" ? (
                      <Button size="lg" variant="secondary" disabled={busy === l.id} onClick={() => advance(l.id, "PREPARING")}>Start</Button>
                    ) : l.status === "PREPARING" ? (
                      <Button size="lg" className="bg-success text-success-foreground hover:bg-success/90" disabled={busy === l.id} onClick={() => advance(l.id, "READY")}>Ready</Button>
                    ) : (
                      <span className="rounded-md bg-junior text-white px-3 py-2 text-sm font-bold">READY</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
