"use client";
// v3 CC-4/CC-5: a booking the club cancelled — move it to a free slot (once, within the window, no extra charge) or
// take a full refund. Used by the member portal and the desk's booking detail.
import { useState } from "react";
import { api, ApiError, useApi } from "./api";
import { Button } from "./ui/button";
import { Field, Select } from "./ui/input";
import { RejectionBanner } from "./states";
import { Money } from "./money";
import { addDays, fmtDateTime, fmtDay } from "@/lib/time";

export type Resolution = { id: string; status: string; amountPaid: number; deadlineAt: string; newBookingId: string | null; rescheduleUntil: string };
type Avail = { today: string; dates: Array<{ date: string; courts: Array<{ courtId: string; name: string; slots: Array<{ time: string; bookable: boolean }> }> }> };

export function ClubCancellationChoice({ r, onDone }: { r: Resolution; onDone: () => void }) {
  const [mode, setMode] = useState<"none" | "move">("none");
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const avail = useApi<Avail>(mode === "move" && date ? `/api/availability?date=${date}` : null);
  const first = useApi<Avail>(mode === "move" && !date ? `/api/availability?date=${r.rescheduleUntil}` : null);
  const today = first.data?.today ?? avail.data?.today ?? null;
  if (r.status === "RESCHEDULED") return <p className="text-sm text-success-text">Moved to a new time at no extra charge.</p>;
  if (r.status === "REFUNDED") return <p className="text-sm text-muted-foreground">Refunded.</p>;
  const days: string[] = [];
  if (today) for (let d = today; d <= r.rescheduleUntil; d = addDays(d, 1)) days.push(d);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onDone(); } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); } finally { setBusy(false); }
  };
  const options = (avail.data?.dates[0]?.courts ?? []).flatMap((c) => c.slots.filter((s) => s.bookable).map((s) => ({ value: `${c.courtId}|${s.time}`, label: `${s.time} · ${c.name}` })));
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="club-cancellation-choice" onClick={(e) => e.stopPropagation()}>
      <p>
        Cancelled by the club. <Money paise={r.amountPaid} className="font-semibold" /> paid — choose by {fmtDateTime(r.deadlineAt)}, otherwise it is refunded automatically.
      </p>
      {mode === "none" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => setMode("move")}>Reschedule (free)</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/api/club-cancellations/${r.id}/refund`, { body: {} }))}>Refund <Money paise={r.amountPaid} /></Button>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Day">
            <Select aria-label="Day" value={date ?? ""} onChange={(e) => { setDate(e.target.value || null); setSlot(""); }}>
              <option value="">Choose a day</option>
              {days.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
            </Select>
          </Field>
          <Field label="Free slot">
            <Select aria-label="Free slot" value={slot} onChange={(e) => setSlot(e.target.value)} disabled={!date}>
              <option value="">{date ? (options.length ? "Choose a time" : "Nothing free that day") : "Pick a day first"}</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button size="sm" disabled={busy || !slot} onClick={() => run(() => {
              const [courtId, startTime] = slot.split("|");
              return api(`/api/club-cancellations/${r.id}/reschedule`, { body: { courtId, date, startTime } });
            })}>Move here</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("none")}>Back</Button>
          </div>
        </div>
      )}
      <RejectionBanner error={error} />
    </div>
  );
}
