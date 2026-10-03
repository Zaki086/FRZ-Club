"use client";
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { fmtDateTime, istToUtc, HOUR, DAY } from "@/lib/time";

type ClockInfo = { now: string; offsetMs: number; production: boolean };

function describeOffset(ms: number) {
  if (ms === 0) return "real time";
  const sign = ms > 0 ? "+" : "−";
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.round((abs % HOUR) / 60_000);
  return `${sign}${d ? `${d}d ` : ""}${h ? `${h}h ` : ""}${m ? `${m}m` : ""}`.trim();
}

export function DevTools() {
  const clock = useApi<ClockInfo>("/api/dev/clock", { pollMs: 5000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("00:05");
  const [jobs, setJobs] = useState<unknown>(null);

  const setOffset = async (offsetMs: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ now: string; offsetMs: number }>("/api/dev/clock", { body: { offsetMs: Math.round(offsetMs) } });
      clock.setData({ now: r.now, offsetMs: r.offsetMs, production: false });
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-lg border-4 border-dashed border-purple-400 bg-purple-50 p-3 text-purple-900" role="alert">
        <FlaskConical className="h-5 w-5" />
        <p className="text-sm"><strong>DEV ONLY.</strong> Disabled when NODE_ENV=production. Shifting the clock affects every business rule (expiry, holds, no-shows) for everyone using this server.</p>
      </div>
      <DataState state={clock}>
        {(c) => {
          const realNow = Date.parse(c.now) - c.offsetMs;
          return (
            <Card>
              <CardHeader><CardTitle>Server business clock</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-3xl font-bold tabular" data-testid="dev-clock-now">{fmtDateTime(c.now)} IST</p>
                <p className="text-sm text-muted-foreground">Offset from real time: {describeOffset(c.offsetMs)}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => setOffset(c.offsetMs + HOUR)}>+1 hour</Button>
                  <Button variant="outline" disabled={busy} onClick={() => setOffset(c.offsetMs + DAY)}>+1 day</Button>
                  <Button variant="outline" disabled={busy} onClick={() => setOffset(c.offsetMs + 7 * DAY)}>+7 days</Button>
                  <Button variant="destructive" disabled={busy || c.offsetMs === 0} onClick={() => setOffset(0)}>Reset to real time</Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Jump to date (IST)"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
                  <Field label="Time"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
                  <Button disabled={busy || !date || !time} onClick={() => setOffset(istToUtc(date, time).getTime() - realNow)}>Set clock</Button>
                </div>
              </CardContent>
            </Card>
          );
        }}
      </DataState>
      <RejectionBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Scheduled jobs</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Runs every job now with the current business clock: no-shows and completions, expired order holds, overdue leads, stale gateway payments, email outbox,
            membership transitions and reminders, overdue invoices and the low-stock digest. All jobs are idempotent.
          </p>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setJobs(await api("/api/dev/run-jobs", { body: {} }));
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Running…" : "Run all jobs now"}
          </Button>
          {jobs ? <pre className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs" data-testid="dev-jobs-result">{JSON.stringify(jobs, null, 2)}</pre> : null}
        </CardContent>
      </Card>
    </div>
  );
}
