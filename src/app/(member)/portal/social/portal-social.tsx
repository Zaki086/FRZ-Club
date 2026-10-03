"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { fmtDay, fmtRange } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { useCapabilities } from "@/components/capabilities";
import { refundSummary } from "@/components/tender-fields";

type Session = { id: string; title: string; date: string; startAt: string; endAt: string; status: string; courts: string[]; capacity: number; joined: number; myParticipantId: string | null };

function Join({ session, memberId, onDone }: { session: Session; memberId: string; onDone: (m: string) => void }) {
  const caps = useCapabilities();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const join = async (kind: "ONLINE" | "LATER") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ fee: number; explanation: string; due: number; payment: { redirectUrl: string } | null }>(`/api/social/${session.id}/join`, {
        body: { player: { memberId }, payment: kind === "ONLINE" ? { kind: "ONLINE", returnUrl: "/portal/social" } : { kind: "LATER" } },
        idempotencyKey: newIdempotencyKey(),
      });
      if (r.payment?.redirectUrl) {
        window.location.href = r.payment.redirectUrl;
        return;
      }
      onDone(`You joined ${session.title} — ${r.explanation}${r.due > 0 ? ` (${formatINR(r.due)} to pay at the desk)` : ""}.`);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {caps?.online ? <Button size="sm" disabled={busy} onClick={() => join("ONLINE")}>Join & pay online</Button> : null}
        <Button size="sm" variant={caps?.online ? "outline" : "default"} disabled={busy} onClick={() => join("LATER")}>Join, pay at desk</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

export function PortalSocial({ memberId, today }: { memberId: string; today: string }) {
  const params = useSearchParams();
  const state = useApi<Session[]>(`/api/social?from=${today}&days=28`);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    void state.reload();
  };
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Social play</h1>
      <p className="text-sm text-muted-foreground">Turn up and play with other members. A social session counts as one of your plays for the day.</p>
      {params.get("payment") === "success" ? <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">Payment received — see you on court!</div> : null}
      {params.get("payment") === "failed" ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">The payment did not go through. You can pay at the desk.</div> : null}
      {msg ? <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">{msg}</div> : null}
      <DataState state={state} isEmpty={(d) => d.filter((s) => s.status === "SCHEDULED").length === 0} empty={{ title: "No social sessions coming up", hint: "Friday social play is scheduled by the club — check back soon." }}>
        {(rows) => (
          <div className="flex flex-col gap-3">
            {rows.filter((s) => s.status === "SCHEDULED").map((s) => {
              const left = s.capacity - s.joined;
              return (
                <Card key={s.id}>
                  <CardContent className="flex flex-col gap-2 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">{s.title}</p>
                        <p className="text-sm text-muted-foreground">{fmtDay(s.date)} · {fmtRange(s.startAt, s.endAt)} · {s.courts.join(", ")}</p>
                      </div>
                      {s.myParticipantId ? <Badge tone="green">You&apos;re in</Badge> : <Badge tone={left > 0 ? "blue" : "red"}>{left > 0 ? `${left} spot${left === 1 ? "" : "s"} left` : "Full"}</Badge>}
                    </div>
                    {s.myParticipantId ? (
                      <ConfirmButton
                        trigger="Leave"
                        title={`Leave ${s.title}?`}
                        description="Leaving 2 hours or more before the start refunds your fee."
                        confirmLabel="Leave session"
                        onConfirm={async () => {
                          const r = await api<{ refunded: number; refundPending: number }>(`/api/social/participants/${s.myParticipantId}/leave`, { body: {} });
                          done(r.refunded > 0 || r.refundPending > 0 ? `You left ${s.title} — ${refundSummary(r.refunded, r.refundPending)}.` : `You left ${s.title}.`);
                        }}
                      />
                    ) : left > 0 ? (
                      <Join session={s} memberId={memberId} onDone={done} />
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>
    </div>
  );
}
