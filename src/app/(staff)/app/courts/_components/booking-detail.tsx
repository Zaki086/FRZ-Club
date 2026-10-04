"use client";
// Booking detail: players with check-in, bill & payment, change players (BK-8), cancel (BK-7).
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { DataState, RejectionBanner } from "@/components/states";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { PaymentPanel } from "@/components/payment-panel";
import { BillRefundRequest } from "@/components/refund-request";
import { ClubCancellationChoice } from "@/components/club-cancellation-choice";
import { emptyRefund, RefundFields, refundBody, refundSummary, type RefundDraft } from "@/components/tender-fields";
import { ConfirmButton } from "@/components/confirm";
import { fmtDateTime, fmtRange } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { PlayerPicker } from "./player-picker";
import { useNow } from "./use-now";
import { errorOf, type BookingView, type PickedPlayer } from "./types";
import { WhatsAppButton } from "@/components/whatsapp-button";
import { SendMessageButton } from "@/components/message-composer";

function CheckIn({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={busy}
        data-testid="checkin"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api("/api/checkin", { body: { bookingPlayerId: id } });
            onDone();
          } catch (e) {
            setError(errorOf(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Check in
      </Button>
      <RejectionBanner error={error} />
    </div>
  );
}

function ChangePlayers({ booking, onDone }: { booking: BookingView; onDone: () => void }) {
  const primaryKey = booking.primaryMemberId ? `m:${booking.primaryMemberId}` : null;
  const initial: PickedPlayer[] = booking.players.map((p) => ({
    key: p.memberId ? `m:${p.memberId}` : `g:${p.guestId}`,
    name: p.name,
    detail: p.tier,
    input: p.memberId ? { memberId: p.memberId } : { guestId: p.guestId! },
  }));
  const [players, setPlayers] = useState<PickedPlayer[]>(initial);
  const [refund, setRefund] = useState<RefundDraft>(emptyRefund);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<{ added: number; removed: number; refunded: number; refundPending: number; due: number } | null>(null);
  const locked = primaryKey ? [primaryKey] : [];
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-semibold">Change players</p>
      <PlayerPicker players={players} onChange={setPlayers} max={8} lockedKeys={locked} />
      <Field label="Refund if money goes back">
        <RefundFields value={refund} onChange={setRefund} />
      </Field>
      <RejectionBanner error={error} />
      {result ? (
        <p className="text-sm text-success-text">
          Updated: +{result.added} / −{result.removed} players{result.refunded || result.refundPending ? ` · ${refundSummary(result.refunded, result.refundPending)}` : ""}{result.due ? ` · ${formatINR(result.due)} now due` : ""}.
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={busy || players.length === 0}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ added: number; removed: number; refunded: number; refundPending: number; due: number }>(`/api/bookings/${booking.id}/players`, {
              body: { players: players.map((p) => p.input), ...refundBody(refund) },
            });
            setResult(r);
            onDone();
          } catch (e) {
            setError(errorOf(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Save players
      </Button>
    </div>
  );
}

export function BookingDetailDialog({ bookingId, onClose, onChanged, canManage = true, canCheckin = true, canMessage = false }: {
  bookingId: string;
  onClose: () => void;
  onChanged: () => void;
  canManage?: boolean;
  canCheckin?: boolean;
  /** v5 §3.3: "Send message" (the composer) for those who may use it. */
  canMessage?: boolean;
}) {
  const state = useApi<BookingView>(`/api/bookings/${bookingId}`);
  const now = useNow();
  const [showChange, setShowChange] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const [refund, setRefund] = useState<RefundDraft>(emptyRefund);
  const [reason, setReason] = useState("");
  const refresh = () => {
    void state.reload();
    onChanged();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={state.data ? `Booking ${state.data.code}` : "Booking"} wide>
        <DataState state={state}>
          {(b) => {
            const upcoming = b.status === "CONFIRMED" && new Date(b.startAt).getTime() > now;
            return (
              <div className="flex flex-col gap-3" data-testid="booking-detail">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{b.court}</span>
                  <span>{fmtDateTime(b.startAt).split(",")[0]} · {fmtRange(b.startAt, b.endAt)}</span>
                  <StatusBadge status={b.status} />
                  <span className="text-muted-foreground">via {b.channel.replace("_", " ").toLowerCase()}</span>
                </div>
                {b.status === "CANCELLED_BY_CLUB" ? <p className="text-sm text-muted-foreground">{b.cancelReason}</p> : null}
                {b.resolution ? <ClubCancellationChoice r={b.resolution} onDone={refresh} /> : null}
                {cancelMsg ? <div className="rounded-md border border-success/40 bg-success/10 p-2 text-sm">{cancelMsg}</div> : null}
                <div className="divide-y rounded-md border">
                  {b.players.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                      <div>
                        <p className="font-medium">
                          {p.name} <TierBadge tier={p.tier} /> {b.primaryMemberId && p.memberId === b.primaryMemberId ? <span className="text-xs text-warning-text">pays</span> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">Fee <Money paise={p.fee} /></p>
                      </div>
                      {p.checkedInAt ? (
                        <span className="text-xs text-success-text">Checked in {fmtDateTime(p.checkedInAt).split(", ")[1]}</span>
                      ) : canCheckin && b.status === "CONFIRMED" ? (
                        <CheckIn id={p.id} onDone={refresh} />
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-sm">
                  <span>Total <Money paise={b.total} className="font-semibold" /></span>
                  <span>Due <Money paise={b.due} className="font-semibold" /> <StatusBadge status={b.billStatus} /></span>
                </div>
                {b.billId && b.due > 0 && b.status !== "CANCELLED" && b.status !== "CANCELLED_BY_CLUB" ? <PaymentPanel billId={b.billId} onPaid={refresh} /> : null}
                {b.billId && b.due === 0 && b.total > 0 && !b.resolution ? <BillRefundRequest billId={b.billId} /> : null}
                <div className="flex flex-wrap gap-2">
                  <WhatsAppButton target={{ template: "BOOKING", bookingId: b.id }} />
                  {canMessage ? <SendMessageButton context="BOOKING" recordId={b.id} /> : null}
                </div>
                {canManage && upcoming ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowChange(!showChange)}>
                      {showChange ? "Hide player changes" : "Change players"}
                    </Button>
                    <ConfirmButton
                      trigger="Cancel booking"
                      title={`Cancel ${b.code}?`}
                      description="Cancelled 2 h or more before start: full refund. Later: no refund, and any unpaid balance stays due (BK-7). The court is freed immediately."
                      confirmLabel="Cancel booking"
                      onConfirm={async () => {
                        const r = await api<{ refunded: number; refundPending: number; fullRefund: boolean }>(`/api/bookings/${b.id}/cancel`, {
                          body: { ...refundBody(refund), reason: reason || undefined },
                        });
                        setCancelMsg(
                          r.refunded > 0 || r.refundPending > 0
                            ? `Cancelled. ${refundSummary(r.refunded, r.refundPending)}.`
                            : r.fullRefund
                              ? "Cancelled. Nothing had been charged."
                              : "Cancelled late — no refund; any unpaid balance stays due.",
                        );
                        refresh();
                      }}
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Refund">
                          <RefundFields value={refund} onChange={setRefund} />
                        </Field>
                        <Field label="Reason (optional)">
                          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                      </div>
                    </ConfirmButton>
                  </div>
                ) : null}
                {showChange && upcoming ? <ChangePlayers booking={b} onDone={refresh} /> : null}
              </div>
            );
          }}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}
