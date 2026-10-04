"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { addDays, fmtDateTime, fmtDay, fmtRange } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { ConsentFields } from "@/components/consent-fields";
import { WhatsAppOptIn } from "@/components/whatsapp-opt-in";
import { useCapabilities } from "@/components/capabilities";
import { EmailInput, PhoneInput } from "@/components/contact-inputs";

type Slot = { time: string; bookable: boolean };
type Court = { courtId: string; name: string; sport: string; slots: Slot[] };
type Avail = { today: string; dates: Array<{ date: string; courts: Court[] }> };
type Result = { bookingCode: string; court: string; startAt: string; endAt: string; fee: number; leadCode: string };

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function TrialForm() {
  const params = useSearchParams();
  const [from] = useState(istToday);
  const state = useApi<Avail>(`/api/availability?date=${from}&days=2`, { pollMs: 30_000 });
  const [date, setDate] = useState(params.get("date") ?? "");
  const [courtId, setCourtId] = useState(params.get("courtId") ?? "");
  const [time, setTime] = useState(params.get("time") ?? "");
  const [f, setF] = useState({ name: "", phone: "", email: "" });
  const [consent, setConsent] = useState(false);
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [website, setWebsite] = useState("");
  const caps = useCapabilities();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  if (result) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <CheckCircle2 className="h-10 w-10 text-primary" />
          <h2 className="text-2xl font-bold">You&apos;re booked, {f.name.split(" ")[0]}!</h2>
          <p>
            <strong>{result.court}</strong>, {fmtDateTime(result.startAt).split(",")[0]} {fmtRange(result.startAt, result.endAt)} · booking <span className="font-mono">{result.bookingCode}</span>
          </p>
          <p>Trial fee: <strong>{result.fee === 0 ? "Free" : `${formatINR(result.fee)} (pay at the desk)`}</strong></p>
          <p className="text-sm text-muted-foreground">Please arrive 10 minutes early and show this code at the front desk. Our team will contact you (reference {result.leadCode}) to answer any questions about membership.</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link href="/plans">See membership plans</Link></Button>
            <Button asChild variant="outline"><Link href="/">Back to home</Link></Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <DataState state={state}>
      {(a) => {
        const days = [a.today, addDays(a.today, 1)];
        const day = a.dates.find((d) => d.date === (date || a.today));
        const court = day?.courts.find((c) => c.courtId === courtId);
        const times = court?.slots.filter((s) => s.bookable) ?? [];
        const selectedDate = date || a.today;
        return (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              if (!courtId || !time) return setError({ message: "Choose a court and a start time." });
              setBusy(true);
              try {
                setResult(await api<Result>("/api/trial", { body: { name: f.name, phone: f.phone, email: f.email || undefined, courtId, date: selectedDate, startTime: time, consent, whatsappOptIn, website: website || undefined } }));
              } catch (err) {
                setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
                void state.reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Card>
              <CardContent className="flex flex-col gap-4 pt-5">
                <p className="font-semibold">1. When</p>
                <div className="flex gap-2">
                  {days.map((d) => (
                    <button type="button" key={d} onClick={() => { setDate(d); setTime(""); }} className={cn("rounded-lg border px-4 py-2 text-sm", selectedDate === d ? "border-primary bg-primary text-white" : "hover:bg-muted")}>
                      {d === a.today ? "Today" : "Tomorrow"} <span className="block text-xs opacity-80">{fmtDay(d)}</span>
                    </button>
                  ))}
                </div>
                <Field label="Court">
                  <Select value={courtId} onChange={(e) => { setCourtId(e.target.value); setTime(""); }} required>
                    <option value="">Choose a court</option>
                    {day?.courts.map((c) => (
                      <option key={c.courtId} value={c.courtId}>{c.name} ({c.slots.filter((s) => s.bookable).length} free starts)</option>
                    ))}
                  </Select>
                </Field>
                {courtId ? (
                  times.length ? (
                    <div className="flex flex-wrap gap-2">
                      {times.map((s) => (
                        <button type="button" key={s.time} onClick={() => setTime(s.time)} className={cn("rounded-md border px-3 py-1.5 text-sm tabular", time === s.time ? "border-primary bg-primary text-white" : "hover:bg-muted")}>{s.time}</button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No free start times left on this court — try another court or day.</p>
                  )
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-3 pt-5">
                <p className="font-semibold">2. About you</p>
                <Field label="Full name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Mobile" hint="10-digit Indian mobile — one trial per number"><PhoneInput name="phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></Field>
                  <Field label="Email (optional)"><EmailInput name="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
                </div>
                <ConsentFields consent={consent} onConsent={setConsent} website={website} onWebsite={setWebsite} clubName={caps?.clubName} />
                <WhatsAppOptIn checked={whatsappOptIn} onChange={setWhatsappOptIn} />
              </CardContent>
            </Card>
            <RejectionBanner error={error} />
            <Button type="submit" size="lg" disabled={busy}>{busy ? "Booking…" : time ? `Book my trial at ${time}` : "Book my trial"}</Button>
          </form>
        );
      }}
    </DataState>
  );
}
