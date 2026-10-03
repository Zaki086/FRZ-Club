"use client";
// CT-4: managers block a court for maintenance (a MAINTENANCE reservation; the exclusion constraint still applies).
// Bookings in the way are never overwritten: the server refuses and lists them; the manager may then confirm a club
// cancellation (refund or reschedule offered, every player told by email, push and WhatsApp).
import { useState } from "react";
import { Wrench } from "lucide-react";
import { api } from "@/components/api";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { minutesToTime, timeToMinutes } from "@/lib/time";
import { errorOf } from "./types";

export function MaintenanceDialog({
  courts,
  date,
  open: openTime,
  close: closeTime,
  onDone,
}: {
  courts: Array<{ courtId: string; name: string }>;
  date: string;
  open: string;
  close: string;
  onDone: () => void;
}) {
  const times: string[] = [];
  for (let m = timeToMinutes(openTime); m <= timeToMinutes(closeTime); m += 30) times.push(minutesToTime(m));
  const [open, setOpen] = useState(false);
  const [courtId, setCourtId] = useState(courts[0]?.courtId ?? "");
  const [day, setDay] = useState(date);
  const [start, setStart] = useState(times[0] ?? "06:00");
  const [end, setEnd] = useState(times[2] ?? "07:00");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  // Set when the server says bookings are in the way; ticking the box resubmits as a club cancellation.
  const [conflict, setConflict] = useState(false);
  const [cancelBookings, setCancelBookings] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setDay(date); else { setError(null); setConflict(false); setCancelBookings(false); } }}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Wrench className="h-4 w-4" /> Block for maintenance
        </Button>
      </DialogTrigger>
      <DialogContent title="Block a court for maintenance" description="Existing bookings are never overwritten: if any are in the way you are asked whether to cancel them as a club cancellation.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/api/maintenance", { body: { courtId, date: day, startTime: start, endTime: end, note, ...(conflict && cancelBookings ? { cancelBookings: true } : {}) } });
              setOpen(false);
              setNote("");
              setConflict(false);
              setCancelBookings(false);
              onDone();
            } catch (err) {
              setError(errorOf(err));
              setConflict(!!(err as { details?: { needsClubCancellation?: boolean } })?.details?.needsClubCancellation);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Court">
            <Select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              {courts.map((c) => <option key={c.courtId} value={c.courtId}>{c.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></Field>
            <Field label="From">
              <Select value={start} onChange={(e) => setStart(e.target.value)}>{times.map((t) => <option key={t}>{t}</option>)}</Select>
            </Field>
            <Field label="To">
              <Select value={end} onChange={(e) => setEnd(e.target.value)}>{times.map((t) => <option key={t}>{t}</option>)}</Select>
            </Field>
          </div>
          <Field label="Reason / note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. resurfacing, net repair" required minLength={3} /></Field>
          <RejectionBanner error={error} />
          {conflict ? (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={cancelBookings} onChange={(e) => setCancelBookings(e.target.checked)} />
              <span>Cancel them and tell the players — each booking becomes “cancelled by the club”, paid ones can be rescheduled or refunded, and everyone is told by email, push and WhatsApp.</span>
            </label>
          ) : null}
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : conflict && cancelBookings ? "Cancel bookings and block court" : "Block court"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
