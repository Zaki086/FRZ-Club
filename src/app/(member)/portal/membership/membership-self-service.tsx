"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDate } from "@/lib/time";
import { formatINR } from "@/lib/money";

type Data = {
  status: MemberStatus;
  memberships: Array<{ id: string; plan: { code: string; name: string }; startDate: string; endDate: string; status: string; price: number; billId: string | null }>;
  nextPlan: { code: string } | null;
};
type Plan = { code: string; name: string; description: string; price1m: number; price3m: number; price12m: number; rank: number };

export function MembershipSelfService({ memberId }: { memberId: string }) {
  const params = useSearchParams();
  const state = useApi<Data>(`/api/members/${memberId}`);
  const plans = useApi<Plan[]>("/api/plans");
  const [mode, setMode] = useState<"renew" | "upgrade">("renew");
  const [plan, setPlan] = useState("");
  const [months, setMonths] = useState(1);
  const [quote, setQuote] = useState<{ total: number; lines: Array<{ description: string; explanation: string }> } | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const payOnline = async (billId: string) => {
    const r = await api<{ redirectUrl: string }>("/api/payments/online/start", { body: { billId, returnUrl: "/portal/membership" }, idempotencyKey: newIdempotencyKey() });
    window.location.assign(r.redirectUrl);
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">My membership</h1>
      {params.get("payment") === "success" ? <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">Payment received — thank you! Your membership is updated and your tax invoice is under Invoices.</div> : null}
      {params.get("payment") === "failed" ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">The payment did not go through. You can try again.</div> : null}
      <DataState state={state}>
        {(d) => {
          const pending = d.memberships.find((m) => m.status === "PENDING_PAYMENT");
          return (
            <>
              <Card>
                <CardContent className="flex flex-col gap-2 pt-4">
                  <MemberStatusBadge status={d.status} />
                  {pending && pending.billId ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/15 p-3 text-sm">
                      <TierBadge tier={pending.plan.code} /> {fmtDate(pending.startDate)} → {fmtDate(pending.endDate)} is waiting for payment of {formatINR(pending.price)}.
                      <Button size="sm" onClick={() => payOnline(pending.billId!).catch((e) => setError(e instanceof ApiError ? e : { message: String(e) }))}>Pay online</Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              {!pending ? (
                <Card>
                  <CardHeader><CardTitle>Renew or upgrade</CardTitle></CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex gap-2">
                      <Button variant={mode === "renew" ? "default" : "outline"} size="sm" onClick={() => { setMode("renew"); setQuote(null); }}>Renew</Button>
                      {d.status.status === "ACTIVE" ? <Button variant={mode === "upgrade" ? "default" : "outline"} size="sm" onClick={() => { setMode("upgrade"); setPlan("GOLD"); setQuote(null); }}>Upgrade</Button> : null}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Plan">
                        <Select value={plan} onChange={(e) => { setPlan(e.target.value); setQuote(null); }}>
                          {mode === "renew" ? <option value="">Keep my plan</option> : null}
                          {(plans.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.name} — {formatINR(p.price1m)}/month</option>)}
                        </Select>
                      </Field>
                      <Field label="Duration">
                        <Select value={months} onChange={(e) => { setMonths(Number(e.target.value)); setQuote(null); }}>
                          <option value={1}>1 month</option><option value={3}>3 months</option><option value={12}>12 months</option>
                        </Select>
                      </Field>
                    </div>
                    {mode === "upgrade" ? (
                      <Button variant="outline" onClick={async () => {
                        setError(null);
                        try { setQuote(await api("/api/memberships/upgrade-quote", { body: { memberId, planCode: plan, months } })); }
                        catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
                      }}>See my price (with credit for unused days)</Button>
                    ) : null}
                    {quote ? <div className="rounded-md bg-muted p-3 text-sm">{quote.lines.map((l, i) => <p key={i}>{l.explanation}</p>)}<p className="font-semibold">To pay: {formatINR(quote.total)}</p></div> : null}
                    <RejectionBanner error={error} />
                    <Button disabled={busy} onClick={async () => {
                      setBusy(true); setError(null);
                      try {
                        const r = await api<{ billId: string; total: number }>(mode === "renew" ? "/api/memberships/renew" : "/api/memberships/upgrade", { body: { memberId, planCode: plan || undefined, months }, idempotencyKey: newIdempotencyKey() });
                        if (r.total > 0) await payOnline(r.billId); else await state.reload();
                      } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
                      finally { setBusy(false); }
                    }}>Continue to payment</Button>
                  </CardContent>
                </Card>
              ) : null}
              <Card>
                <CardHeader><CardTitle>History</CardTitle></CardHeader>
                <CardContent className="divide-y">
                  {d.memberships.map((m) => (
                    <div key={m.id} className="flex items-center justify-between py-2 text-sm">
                      <span><TierBadge tier={m.plan.code} /> {fmtDate(m.startDate)} → {fmtDate(m.endDate)}</span>
                      <span className="flex items-center gap-2"><Money paise={m.price} /><StatusBadge status={m.status} /></span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </>
          );
        }}
      </DataState>
    </div>
  );
}
