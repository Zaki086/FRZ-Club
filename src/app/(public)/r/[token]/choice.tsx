"use client";
// v4 §5.3: Reschedule (a free slot from real availability, no extra charge) or Refund, once. After the choice the
// page shows only the outcome.
import { useState } from "react";
import { CalendarCheck, Clock, Wallet } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { Money } from "@/components/money";
import { addDays, fmtDate, fmtDateTime, fmtDay, fmtRange, istDate } from "@/lib/time";
import type { ResolutionView } from "@/server/services/whatsapp/resolution";

type Avail = { today: string; dates: Array<{ date: string; courts: Array<{ courtId: string; name: string; slots: Array<{ time: string; bookable: boolean }> }> }> };
type Session = Exclude<ResolutionView, { state: "INVALID" }>["session"];

function SessionCard({ s }: { s: Session }) {
  return (
    <Card>
      <CardHeader><CardTitle>Hi {s.firstName}, your session was cancelled by the club</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm" data-testid="resolution-session">
        <p className="font-medium">{s.court} · {fmtDate(istDate(new Date(s.startAt)))} {fmtRange(s.startAt, s.endAt)}</p>
        <p>Booking {s.bookingCode}</p>
        <p>Reason: {s.reason}</p>
        <p>You paid <Money paise={s.amountPaid} className="font-semibold" />.</p>
      </CardContent>
    </Card>
  );
}

function Outcome({ v }: { v: Extract<ResolutionView, { state: "DONE" }> }) {
  const o = v.outcome;
  return (
    <Card data-testid="resolution-outcome">
      <CardHeader><CardTitle>{o.kind === "RESCHEDULED" ? "Moved to a new time" : "Refund"}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {o.kind === "RESCHEDULED" ? (
          <>
            <p className="flex items-center gap-2 font-medium"><CalendarCheck className="h-4 w-4" /> {o.court} · {fmtDate(istDate(new Date(o.startAt)))} {fmtRange(o.startAt, o.endAt)}</p>
            <p>New booking {o.bookingCode}. Already paid: nothing more to pay.</p>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 font-medium"><Wallet className="h-4 w-4" /> <Money paise={o.amount} /> {o.auto ? "refunded automatically" : "refund"}{o.refundCode ? ` · ref ${o.refundCode}` : ""}</p>
            <p>
              {o.collectAtDesk
                ? `Collect it in cash at the front desk${o.refundCode ? ` — say refund ${o.refundCode}` : ""}. Bring your member card or the refund QR from your messages.`
                : o.refundStatus === "COMPLETED" || o.refundStatus === "COLLECTED"
                  ? "It has been paid out."
                  : "The front desk will contact you about it."}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ResolutionChoice({ token, initial }: { token: string; initial: Exclude<ResolutionView, { state: "INVALID" }> }) {
  const [view, setView] = useState(initial);
  const [mode, setMode] = useState<"none" | "move" | "refund">("none");
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const avail = useApi<Avail>(view.state === "OPEN" && mode === "move" && date ? `/api/availability?date=${date}` : null);

  const choose = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<ResolutionView>(`/api/r/${encodeURIComponent(token)}`, { body }) as typeof view);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
      if (e instanceof ApiError && (e.code === "LINK_USED" || e.code === "LINK_EXPIRED")) {
        try { setView(await api<ResolutionView>(`/api/r/${encodeURIComponent(token)}`) as typeof view); } catch { /* keep the message */ }
      }
    } finally {
      setBusy(false);
    }
  };

  if (view.state === "DONE") return (<><SessionCard s={view.session} /><Outcome v={view} /></>);
  if (view.state === "EXPIRED") {
    return (
      <>
        <SessionCard s={view.session} />
        <Card data-testid="resolution-expired">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <Clock className="mt-0.5 h-4 w-4" />
            <p>The time to choose ended {fmtDateTime(view.session.deadlineAt)}. Sessions nobody chose for are refunded in full automatically — ask the front desk if you have questions.</p>
          </CardContent>
        </Card>
      </>
    );
  }

  const days: string[] = [];
  for (let d = view.today; d <= view.rescheduleUntil; d = addDays(d, 1)) days.push(d);
  const options = (avail.data?.dates[0]?.courts ?? []).flatMap((c) => c.slots.filter((s) => s.bookable).map((s) => ({ value: `${c.courtId}|${s.time}`, label: `${s.time} · ${c.name}` })));
  return (
    <>
      <SessionCard s={view.session} />
      <Card data-testid="resolution-choice">
        <CardHeader><CardTitle>Choose by {fmtDateTime(view.session.deadlineAt)}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">Move it to another time (no extra charge) or take a full refund. You can choose once. With no choice by then it is refunded automatically.</p>
          {mode === "none" ? (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => setMode("move")} data-testid="resolution-reschedule">Reschedule (free)</Button>
              <Button variant="outline" disabled={busy} onClick={() => setMode("refund")} data-testid="resolution-refund">Refund <Money paise={view.session.amountPaid} /></Button>
            </div>
          ) : mode === "refund" ? (
            <div className="flex flex-col gap-2">
              <p>Refund <Money paise={view.session.amountPaid} className="font-semibold" /> in full? Cash refunds are collected at the front desk.</p>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => choose({ choice: "REFUND" })} data-testid="resolution-refund-confirm">{busy ? "Working…" : "Yes, refund me"}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setMode("none")}>Back</Button>
              </div>
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
                  <option value="">{date ? (avail.data ? (options.length ? "Choose a time" : "Nothing free that day") : "Loading…") : "Pick a day first"}</option>
                  {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <div className="flex items-end gap-2">
                <Button disabled={busy || !slot} data-testid="resolution-move" onClick={() => {
                  const [courtId, startTime] = slot.split("|");
                  void choose({ choice: "RESCHEDULE", courtId, date, startTime });
                }}>{busy ? "Working…" : "Move here"}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setMode("none")}>Back</Button>
              </div>
            </div>
          )}
          <RejectionBanner error={error} />
        </CardContent>
      </Card>
    </>
  );
}
