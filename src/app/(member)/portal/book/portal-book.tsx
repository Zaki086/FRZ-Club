"use client";
import Link from "next/link";
import { useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { useCapabilities } from "@/components/capabilities";
import { addDays, fmtDay } from "@/lib/time";
import { PortalQuoteView, usePortalQuote, type PortalPlayerInput } from "../_components/booking-quote";

type Slot = { time: string; state: string; label: string; bookable: boolean; past: boolean };
type Court = { courtId: string; name: string; sport: string; maxPlayers: number; active: boolean; slots: Slot[] };
type Avail = { dates: Array<{ date: string; courts: Court[] }> };
type Partner = { key: string; label: string; input: PortalPlayerInput };
type Result = { bookingCode: string; court: string; total: number; due: number; billStatus: string; payment: { redirectUrl: string } | null };

export function PortalBook({ memberId, memberName, today }: { memberId: string; memberName: string; today: string }) {
  const [date, setDate] = useState(today);
  const avail = useApi<Avail>(`/api/availability?date=${date}`, { pollMs: 15000 });
  const [pick, setPick] = useState<{ court: Court; time: string } | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [code, setCode] = useState("");
  const [guestName, setGuestName] = useState("");
  const caps = useCapabilities();
  const [preferOnline, setPayOnline] = useState(true);
  const payOnline = !!caps?.online && preferOnline;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const players: PortalPlayerInput[] = [{ memberId }, ...partners.map((p) => p.input)];
  const { quote, error: quoteError, loading } = usePortalQuote(pick?.court.courtId ?? null, date, pick?.time ?? null, players);
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, i));

  const choose = (court: Court, time: string) => {
    setPick({ court, time });
    setError(null);
    setResult(null);
    setKey(newIdempotencyKey());
  };

  return (
    // While a slot is picked the booking card sticks to the bottom; the padding lets every slot scroll clear of it.
    <div className={cn("flex flex-col gap-4", pick && "pb-[28rem]")}>
      <h1 className="text-2xl font-bold">Book a court</h1>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {days.map((d) => (
          <button
            key={d}
            onClick={() => { setDate(d); setPick(null); }}
            className={cn("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm", d === date ? "border-primary bg-primary text-white" : "bg-card hover:bg-muted")}
          >
            {d === today ? "Today" : fmtDay(d)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Sessions are 60 minutes. How far ahead you can book depends on your plan; the club checks it when you confirm.</p>
      <DataState state={avail}>
        {(a) => (
          <div className="flex flex-col gap-3">
            {a.dates[0].courts.filter((c) => c.active).map((c) => {
              const starts = c.slots.filter((s) => s.bookable);
              return (
                <Card key={c.courtId}>
                  <CardHeader className="pb-1"><CardTitle>{c.name} <span className="text-xs font-normal text-muted-foreground">{c.sport.toLowerCase()}</span></CardTitle></CardHeader>
                  <CardContent>
                    {starts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No free start times on this day.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {starts.map((s) => (
                          <button
                            key={s.time}
                            onClick={() => choose(c, s.time)}
                            className={cn("min-w-16 rounded-md border px-2 py-2 text-sm font-medium", pick?.court.courtId === c.courtId && pick.time === s.time ? "border-primary bg-primary text-white" : "bg-card hover:bg-accent")}
                            data-testid={`slot-${c.name}-${s.time}`}
                          >
                            {s.time}
                          </button>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>

      {pick ? (
        <Card className="sticky bottom-2 max-h-[60vh] overflow-y-auto border-primary shadow-lg">
          <CardHeader className="pb-1"><CardTitle>{pick.court.name} · {fmtDay(date)} · {pick.time}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {result ? (
              <div className="flex flex-col gap-2">
                <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">
                  <p className="font-semibold">{result.bookingCode} confirmed</p>
                  <p>Total <Money paise={result.total} />{result.due > 0 ? <> — <Money paise={result.due} /> to pay at the desk</> : " — nothing to pay"}</p>
                </div>
                <Button asChild><Link href="/portal/bookings">See my bookings</Link></Button>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1 text-sm">
                  <p className="font-medium">Players</p>
                  <p>{memberName} <span className="text-xs text-muted-foreground">(you, paying)</span></p>
                  {partners.map((p) => (
                    <p key={p.key} className="flex items-center justify-between">
                      {p.label}
                      <Button variant="ghost" size="icon" aria-label={`Remove ${p.label}`} onClick={() => setPartners(partners.filter((x) => x.key !== p.key))}><Trash2 className="h-4 w-4" /></Button>
                    </p>
                  ))}
                </div>
                {players.length < pick.court.maxPlayers ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <form className="flex gap-1" onSubmit={(e) => {
                      e.preventDefault();
                      // A member code (CC-000002) or a mobile number (98XXXXXXXX).
                      const raw = code.trim();
                      const digits = raw.replace(/\D/g, "");
                      const isPhone = !/[a-z]/i.test(raw) && digits.length >= 10;
                      const c = isPhone ? digits.slice(-10) : raw.toUpperCase();
                      if (c.length < 3 || partners.some((p) => p.key === c)) return;
                      setPartners([...partners, { key: c, label: isPhone ? `Member with mobile ${c}` : `Member ${c}`, input: isPhone ? { memberPhone: c } : { memberCode: c } }]);
                      setCode("");
                    }}>
                      <Input placeholder="Partner's member code or mobile" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Partner member code or mobile" />
                      <Button type="submit" variant="outline" aria-label="Add partner"><UserPlus className="h-4 w-4" /></Button>
                    </form>
                    <form className="flex gap-1" onSubmit={(e) => {
                      e.preventDefault();
                      const n = guestName.trim();
                      if (n.length < 2) return;
                      setPartners([...partners, { key: `g:${n}:${partners.length}`, label: `${n} (guest)`, input: { guest: { name: n } } }]);
                      setGuestName("");
                    }}>
                      <Input placeholder="Guest name" value={guestName} onChange={(e) => setGuestName(e.target.value)} aria-label="Guest name" />
                      <Button type="submit" variant="outline" aria-label="Add guest"><UserPlus className="h-4 w-4" /></Button>
                    </form>
                  </div>
                ) : null}
                <PortalQuoteView quote={quote} loading={loading} />
                <RejectionBanner error={quoteError} />
                {caps?.online ? (
                  <div className="flex flex-col gap-1 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" checked={payOnline} onChange={() => setPayOnline(true)} /> Pay online now</label>
                    <label className="flex items-center gap-2"><input type="radio" checked={!payOnline} onChange={() => setPayOnline(false)} /> Pay at the desk (before check-in)</label>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Any fee is paid at the front desk before check-in.</p>
                )}
                <RejectionBanner error={error} />
                <Button
                  size="lg"
                  disabled={busy}
                  data-testid="portal-confirm-booking"
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const r = await api<Result>("/api/bookings", {
                        body: {
                          courtId: pick.court.courtId, date, startTime: pick.time, players, primaryIndex: 0, channel: "ONLINE_MEMBER",
                          payment: payOnline ? { kind: "ONLINE", returnUrl: "/portal/bookings" } : { kind: "LATER" },
                        },
                        idempotencyKey: key,
                      });
                      if (r.payment?.redirectUrl) {
                        window.location.href = r.payment.redirectUrl;
                        return;
                      }
                      setResult(r);
                      void avail.reload();
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                      setKey(newIdempotencyKey());
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Booking…" : "Confirm booking"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
