"use client";
// Staff booking dialog (R-10): channel, players, paying player, live server quote, pay now or at check-in.
import { useState } from "react";
import { api, newIdempotencyKey } from "@/components/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/badges";
import { fmtDay, fmtRange } from "@/lib/time";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, UpiQr, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
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
  const methods = useTenderMethods() ?? ["CASH"];
  const [tender, setTender] = useState<TenderDraft>(emptyTender("CASH"));
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
            <div className="rounded-md border border-success/40 bg-success/10 p-3">
              <p className="text-lg font-bold">{result.bookingCode} confirmed</p>
              <p className="text-sm">
                {result.court} · {fmtRange(result.startAt, result.endAt)} · total <Money paise={result.total} /> · <StatusBadge status={result.billStatus} />
              </p>
              {result.due > 0 ? <p className="text-sm text-warning-text">Due at check-in: <Money paise={result.due} /></p> : null}
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
                const r = await api<BookingResult>("/api/bookings", {
                  body: {
                    courtId: target.courtId,
                    date: target.date,
                    startTime: target.time,
                    players: players.map((p) => p.input),
                    primaryIndex: primary,
                    channel,
                    payment: payNow
                      ? { kind: "COUNTER", ...tenderProof(tender) }
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
                <div className="flex flex-col gap-2 pl-6">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <MethodSelect methods={methods} value={tender.method} onChange={(m) => setTender({ ...tender, method: m })} />
                    <ProofFields className="sm:col-span-2" value={tender} due={quote?.total ?? null} onChange={(patch) => setTender({ ...tender, ...patch })} />
                  </div>
                  {tender.method === "UPI" ? <UpiQr amountPaise={quote?.total ?? null} note={`${target.courtName} ${target.date} ${target.time}`} /> : null}
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={!payNow} onChange={() => setPayNow(false)} /> Pay later at check-in (check-in is blocked until paid)
              </label>
            </div>
            {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
            <Button type="submit" size="lg" disabled={busy || players.length === 0} data-testid="confirm-booking">
              {busy ? "Booking…" : "Confirm booking"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
