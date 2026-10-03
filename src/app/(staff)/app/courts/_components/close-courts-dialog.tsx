"use client";
// v3 CC-1/CC-2: Manager/Owner close courts for a time range with a reason. A preview lists every booking and social
// player affected, with what they paid; confirming cancels them, blocks the courts and notifies everyone.
import { useState } from "react";
import { CloudRain } from "lucide-react";
import { api } from "@/components/api";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { Money } from "@/components/money";
import { fmtRange, minutesToTime, timeToMinutes } from "@/lib/time";
import { errorOf } from "./types";

const REASONS = [["WET_COURT", "Wet court"], ["WEATHER", "Weather"], ["MAINTENANCE", "Maintenance"], ["EVENT", "Club event"], ["OTHER", "Other"]] as const;
type Preview = {
  bookings: Array<{ id: string; code: string; court: string; startAt: string; endAt: string; paid: number; primary: string; players: string[] }>;
  social: Array<{ id: string; title: string; startAt: string; endAt: string; participants: Array<{ name: string; paid: number }> }>;
  totals: { bookings: number; paidBookings: number; paid: number; socialParticipants: number };
};

export function CloseCourtsDialog({ courts, date, open: openTime, close: closeTime, onDone }: { courts: Array<{ courtId: string; name: string }>; date: string; open: string; close: string; onDone: () => void }) {
  const times: string[] = [];
  for (let m = timeToMinutes(openTime); m <= timeToMinutes(closeTime); m += 30) times.push(minutesToTime(m));
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [day, setDay] = useState(date);
  const [start, setStart] = useState(times[0] ?? "06:00");
  const [end, setEnd] = useState(times[times.length - 1] ?? "22:00");
  const [reason, setReason] = useState<string>("WET_COURT");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const body = { courtIds: picked, date: day, startTime: start, endTime: end, reason, note };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(errorOf(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setDay(date); setPreview(null); setDone(null); } else setError(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><CloudRain className="h-4 w-4" /> Close courts</Button>
      </DialogTrigger>
      <DialogContent wide title="Close courts" description="Cancels every booking and social session in the range, blocks the courts and tells everyone. Paid players choose a new time or a refund.">
        {done ? (
          <div className="flex flex-col gap-3">
            <p className="rounded-lg bg-success/10 p-3 text-sm text-success-text" data-testid="closure-done">{done}</p>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 text-sm font-semibold">Courts</legend>
              {courts.map((c) => (
                <label key={c.courtId} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={picked.includes(c.courtId)} onChange={(e) => { setPreview(null); setPicked(e.target.checked ? [...picked, c.courtId] : picked.filter((x) => x !== c.courtId)); }} /> {c.name}
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Date"><Input type="date" value={day} onChange={(e) => { setDay(e.target.value); setPreview(null); }} required /></Field>
              <Field label="From"><Select aria-label="Closed from" value={start} onChange={(e) => { setStart(e.target.value); setPreview(null); }}>{times.map((t) => <option key={t}>{t}</option>)}</Select></Field>
              <Field label="To"><Select aria-label="Closed until" value={end} onChange={(e) => { setEnd(e.target.value); setPreview(null); }}>{times.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Reason"><Select aria-label="Closure reason" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label="Note for players" className="col-span-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. rain overnight, courts reopen tomorrow" maxLength={300} /></Field>
            </div>
            {preview ? (
              <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm" data-testid="closure-preview">
                <p className="font-semibold">
                  {preview.totals.bookings} booking{preview.totals.bookings === 1 ? "" : "s"} ({preview.totals.paidBookings} paid) and {preview.totals.socialParticipants} social player{preview.totals.socialParticipants === 1 ? "" : "s"} · <Money paise={preview.totals.paid} /> paid in all
                </p>
                {preview.bookings.map((b) => (
                  <div key={b.id} className="flex justify-between gap-2">
                    <span><span className="font-mono">{b.code}</span> · {b.court} {fmtRange(b.startAt, b.endAt)} · {b.players.join(", ")}</span>
                    {b.paid ? <Money paise={b.paid} className="font-semibold" /> : <span className="text-muted-foreground">unpaid</span>}
                  </div>
                ))}
                {preview.social.map((s) => (
                  <div key={s.id} className="flex justify-between gap-2">
                    <span>{s.title} {fmtRange(s.startAt, s.endAt)} · {s.participants.length} players (refunded automatically)</span>
                    <Money paise={s.participants.reduce((a, p) => a + p.paid, 0)} />
                  </div>
                ))}
              </div>
            ) : null}
            <RejectionBanner error={error} />
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy || !picked.length} onClick={() => run(async () => setPreview(await api<Preview>("/api/closures/preview", { body })))}>Preview</Button>
              <Button disabled={busy || !preview} onClick={() => run(async () => {
                const r = await api<{ code: string; cancelledBookings: number; pendingChoice: number; cancelledSocial: number }>("/api/closures", { body });
                setDone(`${r.code}: ${r.cancelledBookings} booking${r.cancelledBookings === 1 ? "" : "s"} cancelled (${r.pendingChoice} waiting for the player's choice), ${r.cancelledSocial} social session${r.cancelledSocial === 1 ? "" : "s"} cancelled. Everyone has been told.`);
                onDone();
              })}>Close courts and notify</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
