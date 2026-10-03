"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { QrScanner } from "@/components/qr-scanner";
import { fmtDate, fmtRange, istDate } from "@/lib/time";

type Today = {
  member: { name: string };
  today: {
    bookings: Array<{ playerId: string; code: string; court: string; startAt: string; endAt: string; checkedInAt: string | null }>;
    social: Array<{ id: string; title: string; startAt: string; endAt: string; checkedInAt: string | null }>;
  };
};

export function Kiosk({ clubName }: { clubName: string }) {
  const [scanning, setScanning] = useState(true);
  const [data, setData] = useState<Today | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const reset = useCallback(() => {
    setData(null);
    setMessage(null);
    setScanning(true);
  }, []);
  // Back to the scanner after a short pause, so the next member can use it.
  useEffect(() => {
    if (!data && !message) return;
    const t = setTimeout(reset, 20_000);
    return () => clearTimeout(t);
  }, [data, message, reset]);
  const onScan = useCallback(async (payload: string) => {
    setScanning(false);
    setMessage(null);
    try {
      const { memberId } = await api<{ memberId: string }>("/api/members/lookup-card", { body: { payload } });
      setData(await api<Today>(`/api/members/${memberId}`));
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "This card could not be read. Please ask at the desk." });
    }
  }, []);
  const checkIn = async (body: { bookingPlayerId: string } | { socialParticipantId: string }) => {
    try {
      await api("/api/checkin", { body });
      setMessage({ ok: true, text: `Welcome, ${data?.member.name ?? ""}! You're checked in.` });
      setData(null);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const items = data ? [...data.today.bookings.map((b) => ({ key: b.playerId, label: `${b.court} · ${fmtRange(b.startAt, b.endAt)}`, done: !!b.checkedInAt, body: { bookingPlayerId: b.playerId } })), ...data.today.social.map((s) => ({ key: s.id, label: `${s.title} · ${fmtRange(s.startAt, s.endAt)}`, done: !!s.checkedInAt, body: { socialParticipantId: s.id } }))] : [];
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-ink p-6 text-ink-foreground" data-testid="kiosk">
      <h1 className="text-center text-3xl font-black sm:text-4xl">{clubName}</h1>
      {message ? <p className={`max-w-xl rounded-xl p-4 text-center text-xl font-semibold ${message.ok ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"}`}>{message.text}</p> : null}
      {scanning ? (
        <div className="w-full max-w-md rounded-2xl bg-white p-4 text-black">
          <p className="mb-2 text-center text-lg font-semibold">Hold your member card QR up to the camera</p>
          <QrScanner onScan={onScan} onClose={() => setScanning(false)} />
        </div>
      ) : data ? (
        <div className="w-full max-w-md rounded-2xl bg-white p-4 text-black">
          <p className="text-2xl font-bold">Hi {data.member.name.split(" ")[0]}!</p>
          {items.length === 0 ? (
            <p className="mt-2">You have nothing booked today. Please see the front desk.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {items.map((i) => (
                <Button key={i.key} size="xl" disabled={i.done} onClick={() => checkIn(i.body)}>
                  {i.done ? `✓ ${i.label}` : `Check in: ${i.label}`}
                </Button>
              ))}
            </div>
          )}
          <Button variant="ghost" className="mt-3 w-full" onClick={reset}>Done</Button>
        </div>
      ) : (
        <Button size="xl" variant="secondary" onClick={reset}>Scan a card</Button>
      )}
      <KioskSession />
    </div>
  );
}

/** v3 §6.1: the entrance tablet can stay signed in for 90 days instead of the 7-day staff window. */
function KioskSession() {
  const [until, setUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (until) return <p className="text-sm text-white/70">This tablet stays signed in until {fmtDate(istDate(new Date(until)))}.</p>;
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        className="text-sm text-white/70 underline hover:text-white"
        onClick={async () => {
          try {
            setUntil((await api<{ expiresAt: string }>("/api/auth/kiosk", { body: {} })).expiresAt);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        Keep this tablet signed in as a kiosk (90 days)
      </button>
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
    </div>
  );
}
