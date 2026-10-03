"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/confirm";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDay, fmtRange, istDate } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { useNow } from "../_components/use-now";

type B = {
  id: string; code: string; court: string; startAt: string; endAt: string; status: string; primaryMemberId: string | null;
  players: Array<{ name: string; memberId: string | null; fee: number }>; billId: string | null; total: number; due: number; billStatus: string;
};
type Dues = { dues: Array<{ id: string; sourceType: string; due: number; createdAt: string; description: string }> };

function PayOnline({ billId, label = "Pay online" }: { billId: string; label?: string }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={async () => {
        setError(null);
        try {
          const r = await api<{ redirectUrl: string }>("/api/payments/online/start", { body: { billId, returnUrl: "/portal/bookings" }, idempotencyKey: newIdempotencyKey() });
          window.location.href = r.redirectUrl;
        } catch (e) {
          setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
        }
      }}>{label}</Button>
      <RejectionBanner error={error} />
    </div>
  );
}

function BookingRow({ b, memberId, onChanged, upcoming }: { b: B; memberId: string; onChanged: (msg: string) => void; upcoming: boolean }) {
  const mine = b.primaryMemberId === memberId;
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="font-semibold">{b.court} · {fmtDay(istDate(new Date(b.startAt)))} {fmtRange(b.startAt, b.endAt)}</p>
        <p className="text-xs text-muted-foreground"><span className="font-mono">{b.code}</span> · {b.players.map((p) => p.name).join(", ")}</p>
        <a className="text-xs text-primary underline" href={`/api/bookings/${b.id}/ics`} download>Add to calendar</a>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={b.status} /> Total <Money paise={b.total} />
          {b.due > 0 ? <span className="font-semibold text-amber-700">· {formatINR(b.due)} due</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {mine && b.billId && b.due > 0 && b.status !== "CANCELLED" ? <PayOnline billId={b.billId} /> : null}
        {upcoming && mine && b.status === "CONFIRMED" ? (
          <ConfirmButton
            trigger="Cancel"
            title={`Cancel ${b.code}?`}
            description="Cancel 2 hours or more before the start for a full refund. Later cancellations are not refunded."
            confirmLabel="Cancel booking"
            onConfirm={async () => {
              const r = await api<{ refunded: number; fullRefund: boolean }>(`/api/bookings/${b.id}/cancel`, { body: {} });
              onChanged(r.refunded > 0 ? `${b.code} cancelled — ${formatINR(r.refunded)} refunded.` : r.fullRefund ? `${b.code} cancelled — nothing was charged.` : `${b.code} cancelled — too late for a refund.`);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function MyBookings({ memberId }: { memberId: string }) {
  const params = useSearchParams();
  const state = useApi<B[]>("/api/me/bookings");
  const dues = useApi<Dues>(`/api/members/${memberId}`);
  const [msg, setMsg] = useState<string | null>(null);
  const now = useNow();
  const changed = (m: string) => {
    setMsg(m);
    void state.reload();
    void dues.reload();
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My bookings</h1>
        <Button asChild size="sm"><Link href="/portal/book"><CalendarPlus className="h-4 w-4" /> Book</Link></Button>
      </div>
      {params.get("payment") === "success" ? <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">Payment received — thank you!</div> : null}
      {params.get("payment") === "failed" ? <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">The payment did not go through. You can try again or pay at the desk.</div> : null}
      {msg ? <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm">{msg}</div> : null}
      <DataState state={state}>
        {(rows) => {
          const upcoming = rows.filter((b) => new Date(b.endAt).getTime() > now && b.status === "CONFIRMED").sort((a, b) => a.startAt.localeCompare(b.startAt));
          const past = rows.filter((b) => !upcoming.includes(b));
          return (
            <>
              <Card>
                <CardHeader><CardTitle>Upcoming</CardTitle></CardHeader>
                <CardContent className="divide-y">
                  {upcoming.length === 0 ? <Empty title="No upcoming bookings" hint="Book a court for up to your plan's booking window." /> : upcoming.map((b) => <BookingRow key={b.id} b={b} memberId={memberId} onChanged={changed} upcoming />)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Past & cancelled</CardTitle></CardHeader>
                <CardContent className="divide-y">
                  {past.length === 0 ? <Empty title="No past bookings yet" /> : past.map((b) => <BookingRow key={b.id} b={b} memberId={memberId} onChanged={changed} upcoming={false} />)}
                </CardContent>
              </Card>
            </>
          );
        }}
      </DataState>
      <Card>
        <CardHeader><CardTitle>My dues</CardTitle></CardHeader>
        <CardContent>
          <DataState state={dues} isEmpty={(d) => d.dues.length === 0} empty={{ title: "You don't owe anything" }}>
            {(d) => (
              <div className="divide-y">
                {d.dues.map((x) => (
                  <div key={x.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div><p>{x.description}</p><p className="text-xs text-muted-foreground">{x.sourceType.replace("_", " ").toLowerCase()}</p></div>
                    <div className="flex items-center gap-2"><Money paise={x.due} className="font-semibold" /><PayOnline billId={x.id} label="Pay" /></div>
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
