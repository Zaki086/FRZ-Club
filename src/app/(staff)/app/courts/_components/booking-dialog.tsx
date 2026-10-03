"use client";
// Staff booking dialog (R-10): channel, players, paying player, live server quote, pay now or at check-in.
import { useState } from "react";
import { api, newIdempotencyKey } from "@/components/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/badges";
import { fmtDay, fmtRange } from "@/lib/time";
import { parseRupees } from "@/lib/money";
import { PlayerPicker } from "./player-picker";
import { QuoteView } from "./quote-view";
import { useBookingQuote } from "./use-quote";
import { errorOf, type BookingResult, type PickedPlayer } from "./types";

export type NewBookingTarget = { courtId: string; courtName: string; maxPlayers: number; date: string; time: string };

const CHANNELS = [
  { value: "FRONT_DESK", label: "Front desk" },
  { value: "PHONE", label: "Phone call" },
  { value: "MESSAGE", label: "WhatsApp / message" },
  { value: "WALK_IN", label: "Walk-in" },
] as const;

export function BookingDialog({
  target,
  prefill,
  onClose,
  onBooked,
}: {
  target: NewBookingTarget;
  prefill?: PickedPlayer | null;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [players, setPlayers] = useState<PickedPlayer[]>(prefill ? [prefill] : []);
  const [primary, setPrimary] = useState(0);
  const [channel, setChannel] = useState<string>("FRONT_DESK");
  const [payNow, setPayNow] = useState(true);
  const [method, setMethod] = useState<"CASH" | "CARD" | "UPI">("UPI");
  const [reference, setReference] = useState("");
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [key] = useState(newIdempotencyKey);
  const { quote, error: quoteError, loading } = useBookingQuote(target.courtId, target.date, target.time, players.map((p) => p.input));

  const startDate = new Date(`${target.date}T${target.time}:00+05:30`);
  const endDate = new Date(startDate.getTime() + 60 * 60_000);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={`Book ${target.courtName}`} description={`${fmtDay(target.date)} · ${fmtRange(startDate, endDate)} (60 minutes)`} wide>
        {result ? (
          <div className="flex flex-col gap-3" data-testid="booking-success">
            <div className="rounded-md border border-green-300 bg-green-50 p-3">
              <p className="text-lg font-bold">{result.bookingCode} confirmed</p>
              <p className="text-sm">
                {result.court} · {fmtRange(result.startAt, result.endAt)} · total <Money paise={result.total} /> · <StatusBadge status={result.billStatus} />
              </p>
              {result.due > 0 ? <p className="text-sm text-amber-800">Due at check-in: <Money paise={result.due} /></p> : null}
            </div>
            <ul className="text-sm">
              {result.players.map((p, i) => (
                <li key={i}>
                  {p.name} — <Money paise={p.fee} /> <span className="text-xs text-muted-foreground">({p.explanation})</span>
                </li>
              ))}
            </ul>
            <Button onClick={() => { onBooked(); onClose(); }}>Done</Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const tenderedPaise = tendered ? parseRupees(tendered) : null;
                const r = await api<BookingResult>("/api/bookings", {
                  body: {
                    courtId: target.courtId,
                    date: target.date,
                    startTime: target.time,
                    players: players.map((p) => p.input),
                    primaryIndex: primary,
                    channel,
                    payment: payNow
                      ? { kind: "COUNTER", method, reference: reference || undefined, tendered: method === "CASH" && tenderedPaise ? tenderedPaise : undefined }
                      : { kind: "LATER" },
                  },
                  idempotencyKey: key,
                });
                setResult(r);
                onBooked();
              } catch (err) {
                setError(errorOf(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Request came in by">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </Select>
            </Field>
            <div>
              <p className="mb-1 text-sm font-medium">Players (★ = paying player)</p>
              <PlayerPicker players={players} onChange={setPlayers} max={target.maxPlayers} primaryIndex={primary} onPrimary={setPrimary} />
            </div>
            <QuoteView quote={quote} loading={loading} />
            <RejectionBanner error={quoteError} />
            <div className="flex flex-col gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={payNow} onChange={() => setPayNow(true)} /> Pay now (full amount)
              </label>
              {payNow ? (
                <div className="grid grid-cols-3 gap-2 pl-6">
                  <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Payment method">
                    <option value="UPI">UPI</option>
                    <option value="CARD">Card</option>
                    <option value="CASH">Cash</option>
                  </Select>
                  {method === "CASH" ? (
                    <Input placeholder="Tendered ₹ (optional)" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} aria-label="Cash tendered" />
                  ) : (
                    <Input placeholder={method === "UPI" ? "UTR / ref" : "Card last 4"} value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Reference" />
                  )}
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={!payNow} onChange={() => setPayNow(false)} /> Pay later at check-in (check-in is blocked until paid)
              </label>
            </div>
            <RejectionBanner error={error} />
            <Button type="submit" size="lg" disabled={busy || players.length === 0} data-testid="confirm-booking">
              {busy ? "Booking…" : "Confirm booking"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
