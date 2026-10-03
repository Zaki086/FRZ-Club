"use client";
import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CalendarPlus, Phone, Beer } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { MemberCard } from "@/components/member-card";
import { CredentialsPanel } from "@/components/credentials-panel";
import { Money } from "@/components/money";
import { StatusBadge, TierBadge } from "@/components/badges";
import { PaymentPanel } from "@/components/payment-panel";
import { ConfirmButton } from "@/components/confirm";
import { fmtDate, fmtDateTime, fmtRange } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";
import { WhatsAppButton } from "@/components/whatsapp-button";
import { ResetLinkButton } from "@/components/reset-link-button";

type P360 = {
  member: { id: string; memberCode: string; name: string; phone: string; email: string | null; dob: string; photoUrl: string | null; emergencyContactName: string | null; emergencyContactPhone: string | null };
  status: MemberStatus;
  memberships: Array<{ id: string; plan: { code: string; name: string }; startDate: string; endDate: string; status: string; price: number; creditApplied: number; kind: string; billId: string | null }>;
  nextPlan: { code: string; name: string; months: number | null } | null;
  today: {
    bookings: Array<{ id: string; code: string; court: string; startAt: string; endAt: string; status: string; playerId: string; checkedInAt: string | null; billId: string | null }>;
    social: Array<{ id: string; title: string; startAt: string; endAt: string; checkedInAt: string | null; billId: string | null }>;
  };
  bookings: Array<{ id: string; code: string; court: string; startAt: string; endAt: string; status: string; isPrimary: boolean; fee: number; tier: string }>;
  social: Array<{ id: string; title: string; startAt: string; status: string; fee: number }>;
  visits: Array<{ id: string; checkedInAt: string; checkedOutAt: string | null }>;
  lastVisit: string | null;
  purchases: Array<{ id: string; sourceType: string; total: number; status: string; createdAt: string; discountTotal: number }>;
  tabs: Array<{ id: string; code: string; status: string; total: number; due: number; createdAt: string }>;
  openTab: { id: string; code: string; total: number; due: number } | null;
  payments: Array<{ id: string; type: string; method: string; amount: number; status: string; occurredAt: string; reference: string | null }>;
  dues: Array<{ id: string; sourceType: string; due: number; createdAt: string; description: string }>;
  totals: { bookings: number; courtSpend: number; shopSpend: number; barSpend: number; membershipSpend: number; discountsSaved: number; visits: number; dueTotal: number };
};

type Perms = { manage: boolean; cancel: boolean; checkin: boolean; book: boolean; passwordLinks: boolean };

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function PayDialog({ billId, label, onDone }: { billId: string; label: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) onDone(); }}>
      <DialogTrigger asChild>
        <Button size="sm">{label}</Button>
      </DialogTrigger>
      <DialogContent title="Take payment" wide>
        <PaymentPanel billId={billId} onPaid={onDone} />
      </DialogContent>
    </Dialog>
  );
}

function PlanChangeDialog({ memberId, mode, onDone }: { memberId: string; mode: "renew" | "upgrade" | "downgrade"; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState(mode === "downgrade" ? "SILVER" : mode === "upgrade" ? "GOLD" : "");
  const [months, setMonths] = useState(1);
  const [quote, setQuote] = useState<{ total: number; lines: Array<{ explanation: string; description: string }> } | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const title = mode === "renew" ? "Renew membership" : mode === "upgrade" ? "Upgrade membership" : "Schedule a downgrade";
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setBillId(null); setQuote(null); setError(null); onDone(); } }}>
      <DialogTrigger asChild>
        <Button variant={mode === "renew" ? "default" : "outline"} size="sm">{title.split(" ")[0]}</Button>
      </DialogTrigger>
      <DialogContent title={title} description={mode === "upgrade" ? "Takes effect today; unused days of the current plan are credited (MB-7)." : mode === "downgrade" ? "Takes effect at the next renewal; no refunds (MB-8)." : "Starts the day after the current membership ends, or today if expired (MB-6)."} wide>
        {billId ? (
          <PaymentPanel billId={billId} onPaid={onDone} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Plan">
                <Select value={plan} onChange={(e) => { setPlan(e.target.value); setQuote(null); }}>
                  {mode === "renew" ? <option value="">Same plan (or scheduled downgrade)</option> : null}
                  <option value="GOLD">Gold</option>
                  <option value="SILVER">Silver</option>
                  <option value="JUNIOR">Junior</option>
                </Select>
              </Field>
              <Field label="Duration">
                <Select value={months} onChange={(e) => { setMonths(Number(e.target.value)); setQuote(null); }}>
                  <option value={1}>1 month</option>
                  <option value={3}>3 months</option>
                  <option value={12}>12 months</option>
                </Select>
              </Field>
            </div>
            {mode === "upgrade" ? (
              <Button variant="outline" onClick={async () => {
                setError(null);
                try { setQuote(await api("/api/memberships/upgrade-quote", { body: { memberId, planCode: plan, months } })); }
                catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
              }}>Show price with credit</Button>
            ) : null}
            {quote ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                {quote.lines.map((l, i) => <p key={i}>{l.description}<br /><span className="text-muted-foreground">{l.explanation}</span></p>)}
                <p className="mt-1 text-base font-semibold">To pay: {formatINR(quote.total)}</p>
              </div>
            ) : null}
            <RejectionBanner error={error} />
            <Button disabled={busy} onClick={async () => {
              setBusy(true); setError(null);
              try {
                const path = mode === "renew" ? "/api/memberships/renew" : mode === "upgrade" ? "/api/memberships/upgrade" : "/api/memberships/downgrade";
                const r = await api<{ billId?: string; total?: number }>(path, { body: { memberId, planCode: plan || undefined, months }, idempotencyKey: newIdempotencyKey() });
                if (r.billId && (r.total ?? 0) > 0) setBillId(r.billId);
                else { setOpen(false); onDone(); }
              } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
              finally { setBusy(false); }
            }}>{mode === "downgrade" ? "Schedule downgrade" : "Create & take payment"}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelMembership({ membershipId, onDone }: { membershipId: string; onDone: () => void }) {
  const [refund, setRefund] = useState("");
  return (
    <ConfirmButton
      trigger="Cancel membership"
      title="Cancel membership"
      description="Owner/Manager only (MB-13). This is audited. A refund, if agreed, becomes a refund request: someone else approves it and the desk pays it out the way the member paid."
      requireReason
      confirmLabel="Cancel membership"
      onConfirm={async (reason) => {
        const amount = refund ? parseRupees(refund) : null;
        await api("/api/memberships/cancel", { body: { membershipId, reason, refundAmount: amount ?? undefined } });
        onDone();
      }}
    >
      <Field label="Refund to request (₹, optional)"><Input value={refund} onChange={(e) => setRefund(e.target.value)} inputMode="decimal" /></Field>
    </ConfirmButton>
  );
}

function CheckInButton({ kind, id, onDone }: { kind: "booking" | "social"; id: string; onDone: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={busy} data-testid="checkin" onClick={async () => {
        setBusy(true); setError(null);
        try { await api("/api/checkin", { body: kind === "booking" ? { bookingPlayerId: id } : { socialParticipantId: id } }); onDone(); }
        catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); }
        finally { setBusy(false); }
      }}>Check in</Button>
      <RejectionBanner error={error} />
    </div>
  );
}

export function Member360({ memberId, perms }: { memberId: string; perms: Perms }) {
  const state = useApi<P360>(`/api/members/${memberId}`);
  const reload = () => void state.reload();
  return (
    <DataState state={state}>
      {(p) => {
        const current = p.memberships.find((m) => m.status === "ACTIVE");
        const pending = p.memberships.find((m) => m.status === "PENDING_PAYMENT");
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-4">
              {p.member.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.member.photoUrl} alt={p.member.name} className="h-20 w-20 rounded-full object-cover ring-2 ring-border" />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted text-2xl font-bold text-muted-foreground">{p.member.name.charAt(0)}</div>
              )}
              <div className="flex flex-1 flex-col gap-1">
                <h1 className="text-2xl font-bold">{p.member.name}</h1>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-mono">{p.member.memberCode}</span>
                  <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{p.member.phone}</span>
                  {p.member.email ? <span>{p.member.email}</span> : null}
                  <span>DOB {fmtDate(p.member.dob)}</span>
                </p>
                <MemberStatusBadge status={p.status} />
                {p.status.status === "EXPIRED" ? <p className="text-sm font-semibold text-destructive">EXPIRED — priced as a walk-in until renewed (MB-10).</p> : null}
                {p.nextPlan ? <p className="text-sm">Scheduled downgrade to <TierBadge tier={p.nextPlan.code} /> at next renewal.</p> : null}
                <p className="text-xs text-muted-foreground">
                  Emergency: {p.member.emergencyContactName ?? "—"} {p.member.emergencyContactPhone ?? ""} · Last visit: {p.lastVisit ? fmtDateTime(p.lastVisit) : "never"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {perms.book ? (
                  <Button asChild variant="outline" size="sm"><Link href={`/app/courts?member=${p.member.id}`}><CalendarPlus className="h-4 w-4" />Book court</Link></Button>
                ) : null}
                {perms.manage ? (
                  <>
                    <PlanChangeDialog memberId={p.member.id} mode="renew" onDone={reload} />
                    {current ? <PlanChangeDialog memberId={p.member.id} mode="upgrade" onDone={reload} /> : null}
                    {current ? <PlanChangeDialog memberId={p.member.id} mode="downgrade" onDone={reload} /> : null}
                  </>
                ) : null}
                {perms.cancel && (current || pending) ? <CancelMembership membershipId={(current ?? pending)!.id} onDone={reload} /> : null}
                <WhatsAppButton target={{ template: "MEMBERSHIP", memberId: p.member.id }} label="WhatsApp membership status" />
                {perms.passwordLinks ? <ResetLinkButton url={`/api/members/${p.member.id}/reset-link`} /> : null}
              </div>
            </div>

            {p.openTab ? (
              <div className="flex items-center gap-2 rounded-md border border-warning/50 bg-warning/15 p-3 text-sm text-warning-foreground">
                <Beer className="h-4 w-4" /> Open bar tab {p.openTab.code}: {formatINR(p.openTab.due)} to settle before leaving (E-13).
              </div>
            ) : null}
            {p.totals.dueTotal > 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> Outstanding dues: {formatINR(p.totals.dueTotal)}
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="flex flex-col gap-3 lg:col-span-1"><MemberCard memberId={p.member.id} /><CredentialsPanel memberId={p.member.id} /></div>
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>Today</CardTitle></CardHeader>
                <CardContent>
                  {p.today.bookings.length === 0 && p.today.social.length === 0 ? (
                    <Empty title="Nothing booked today" />
                  ) : (
                    <div className="divide-y">
                      {p.today.bookings.map((b) => (
                        <div key={b.id} className="flex items-center justify-between gap-2 py-2">
                          <div>
                            <p className="font-medium">{b.court} · {fmtRange(b.startAt, b.endAt)} <span className="font-mono text-xs text-muted-foreground">{b.code}</span></p>
                            <StatusBadge status={b.status} />
                          </div>
                          {b.checkedInAt ? <span className="text-sm text-success-text">Checked in {fmtDateTime(b.checkedInAt).split(", ")[1]}</span> : perms.checkin && b.status === "CONFIRMED" ? <CheckInButton kind="booking" id={b.playerId} onDone={reload} /> : null}
                        </div>
                      ))}
                      {p.today.social.map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 py-2">
                          <p className="font-medium">Social: {s.title} · {fmtRange(s.startAt, s.endAt)}</p>
                          {s.checkedInAt ? <span className="text-sm text-success-text">Checked in</span> : perms.checkin ? <CheckInButton kind="social" id={s.id} onDone={reload} /> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <Stat label="Bookings" value={p.totals.bookings} />
              <Stat label="Visits" value={p.totals.visits} />
              <Stat label="Court spend" value={<Money paise={p.totals.courtSpend} />} />
              <Stat label="Shop spend" value={<Money paise={p.totals.shopSpend} />} />
              <Stat label="Bar spend" value={<Money paise={p.totals.barSpend} />} />
              <Stat label="Memberships" value={<Money paise={p.totals.membershipSpend} />} />
              <Stat label="Discounts saved" value={<Money paise={p.totals.discountsSaved} />} />
              <Stat label="Dues" value={<Money paise={p.totals.dueTotal} />} />
            </div>

            <Tabs defaultValue="memberships">
              <TabsList>
                <TabsTrigger value="memberships">Memberships</TabsTrigger>
                <TabsTrigger value="bookings">Bookings</TabsTrigger>
                <TabsTrigger value="social">Social</TabsTrigger>
                <TabsTrigger value="visits">Visits</TabsTrigger>
                <TabsTrigger value="purchases">Purchases</TabsTrigger>
                <TabsTrigger value="tabs">Bar tabs</TabsTrigger>
                <TabsTrigger value="payments">Payments</TabsTrigger>
                <TabsTrigger value="dues">Dues ({p.dues.length})</TabsTrigger>
              </TabsList>
              <Card className="mt-2">
                <TabsContent value="memberships">
                  {p.memberships.length === 0 ? <Empty title="No memberships yet" /> : (
                    <Table><THead><TR><TH>Plan</TH><TH>Period</TH><TH>Type</TH><TH>Price</TH><TH>Status</TH><TH /></TR></THead>
                      <TBody>{p.memberships.map((m) => (
                        <TR key={m.id}>
                          <TD><TierBadge tier={m.plan.code} /></TD>
                          <TD>{fmtDate(m.startDate)} → {fmtDate(m.endDate)}</TD>
                          <TD>{m.kind}</TD>
                          <TD><Money paise={m.price} />{m.creditApplied ? <span className="text-xs text-muted-foreground"> (credit {formatINR(m.creditApplied)})</span> : null}</TD>
                          <TD><StatusBadge status={m.status} /></TD>
                          <TD>{m.status === "PENDING_PAYMENT" && m.billId && perms.manage ? <PayDialog billId={m.billId} label="Take payment" onDone={reload} /> : null}</TD>
                        </TR>))}
                      </TBody></Table>)}
                </TabsContent>
                <TabsContent value="bookings">
                  {p.bookings.length === 0 ? <Empty title="No bookings yet" /> : (
                    <Table><THead><TR><TH>Code</TH><TH>Court</TH><TH>When</TH><TH>Fee</TH><TH>Status</TH></TR></THead>
                      <TBody>{p.bookings.map((b) => (
                        <TR key={b.id}><TD className="font-mono text-xs">{b.code}</TD><TD>{b.court}</TD><TD>{fmtDateTime(b.startAt)}</TD><TD><Money paise={b.fee} /> <span className="text-xs text-muted-foreground">{b.tier}</span></TD><TD><StatusBadge status={b.status} /></TD></TR>))}
                      </TBody></Table>)}
                </TabsContent>
                <TabsContent value="social">
                  {p.social.length === 0 ? <Empty title="No social play yet" /> : (
                    <Table><THead><TR><TH>Session</TH><TH>When</TH><TH>Fee</TH><TH>Status</TH></TR></THead>
                      <TBody>{p.social.map((s) => (<TR key={s.id}><TD>{s.title}</TD><TD>{fmtDateTime(s.startAt)}</TD><TD><Money paise={s.fee} /></TD><TD><StatusBadge status={s.status} /></TD></TR>))}</TBody></Table>)}
                </TabsContent>
                <TabsContent value="visits">
                  {p.visits.length === 0 ? <Empty title="No visits recorded" /> : (
                    <Table><THead><TR><TH>Checked in</TH><TH>Checked out</TH></TR></THead>
                      <TBody>{p.visits.map((v) => (<TR key={v.id}><TD>{fmtDateTime(v.checkedInAt)}</TD><TD>{v.checkedOutAt ? fmtDateTime(v.checkedOutAt) : "—"}</TD></TR>))}</TBody></Table>)}
                </TabsContent>
                <TabsContent value="purchases">
                  {p.purchases.length === 0 ? <Empty title="No shop purchases yet" /> : (
                    <Table><THead><TR><TH>Date</TH><TH>Type</TH><TH>Total</TH><TH>Saved</TH><TH>Status</TH></TR></THead>
                      <TBody>{p.purchases.map((b) => (<TR key={b.id}><TD>{fmtDateTime(b.createdAt)}</TD><TD>{b.sourceType.replace("_", " ")}</TD><TD><Money paise={b.total} /></TD><TD><Money paise={b.discountTotal} /></TD><TD><StatusBadge status={b.status} /></TD></TR>))}</TBody></Table>)}
                </TabsContent>
                <TabsContent value="tabs">
                  {p.tabs.length === 0 ? <Empty title="No bar tabs yet" /> : (
                    <Table><THead><TR><TH>Tab</TH><TH>Opened</TH><TH>Total</TH><TH>Due</TH><TH>Status</TH></TR></THead>
                      <TBody>{p.tabs.map((t) => (<TR key={t.id}><TD className="font-mono text-xs">{t.code}</TD><TD>{fmtDateTime(t.createdAt)}</TD><TD><Money paise={t.total} /></TD><TD><Money paise={t.due} /></TD><TD><StatusBadge status={t.status} /></TD></TR>))}</TBody></Table>)}
                </TabsContent>
                <TabsContent value="payments">
                  {p.payments.length === 0 ? <Empty title="No payments yet" /> : (
                    <Table><THead><TR><TH>When</TH><TH>Type</TH><TH>Method</TH><TH>Amount</TH><TH>Status</TH><TH>Ref</TH></TR></THead>
                      <TBody>{p.payments.map((x) => (<TR key={x.id}><TD>{fmtDateTime(x.occurredAt)}</TD><TD>{x.type}</TD><TD>{x.method}</TD><TD><Money paise={x.type === "REFUND" ? -x.amount : x.amount} /></TD><TD><StatusBadge status={x.status} /></TD><TD className="text-xs">{x.reference ?? ""}</TD></TR>))}</TBody></Table>)}
                </TabsContent>
                <TabsContent value="dues">
                  {p.dues.length === 0 ? <Empty title="No outstanding dues" /> : (
                    <Table><THead><TR><TH>Since</TH><TH>For</TH><TH>Due</TH><TH /></TR></THead>
                      <TBody>{p.dues.map((d) => (<TR key={d.id}><TD>{fmtDateTime(d.createdAt)}</TD><TD>{d.description}</TD><TD><Money paise={d.due} /></TD><TD>{perms.checkin ? <PayDialog billId={d.id} label="Collect" onDone={reload} /> : null}</TD></TR>))}</TBody></Table>)}
                </TabsContent>
              </Card>
            </Tabs>
          </div>
        );
      }}
    </DataState>
  );
}
