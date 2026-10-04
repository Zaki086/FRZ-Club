"use client";
// v4 §1.2 "Cash Drawers" (Owner): all tills with live balances, the safe (§2.6) and bank deposits.
import Link from "next/link";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";
import { uploadFile } from "@/components/upload";
import { fmtDate, fmtDateTime, istDate } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";

type Till = {
  id: string; name: string; location: string; active: boolean; defaultFloat: number;
  open: { sessionId: string; staff: string; since: string; balance: number } | null;
  lastClose: { sessionId: string; at: string; floatCarried: number | null; status: string; variance: number | null } | null;
};
type Overview = { tills: Till[]; collectedTodayPaise: number; inDrawersNowPaise: number; inSafePaise: number; pendingApprovals: number; canDeposit: boolean };
type Safe = {
  balance: number;
  movements: Array<{ id: string; lineNo: number; type: string; amount: number; balanceAfter: number; reference: string | null; note: string | null; actor: string | null; at: string }>;
  deposits: Array<{ id: string; amount: number; depositDate: string; slipRef: string; photoUrl: string | null; note: string | null; source: string }>;
};

const LOCATION: Record<string, string> = { FRONT_DESK: "Front desk", SHOP: "Shop", BAR: "Bar", OFFICE: "Office" };
const SAFE_LABEL: Record<string, string> = { CASH_DROP: "Cash drop in", PAY_IN: "Pay-in out to a drawer", BANK_DEPOSIT: "Bank deposit" };

function Tile({ label, paise, testId }: { label: string; paise: number; testId?: string }) {
  return (
    <div className="flex flex-col rounded-2xl border bg-card p-3 shadow-soft" data-testid={testId}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="font-display text-2xl font-bold tabular">{formatINR(paise)}</span>
    </div>
  );
}

function DepositDialog({ open, onOpenChange, safe, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; safe: number; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(istDate(new Date()));
  const [slip, setSlip] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record a bank deposit" description={`The safe holds ${formatINR(safe)}.`}>
        <div className="flex flex-col gap-3">
          <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Deposit date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Slip reference"><Input value={slip} onChange={(e) => setSlip(e.target.value)} /></Field>
          <Field label="Slip photo (optional)">
            <Input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setError(null);
              try {
                setPhoto(await uploadFile("deposit", f));
              } catch (err) {
                setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
              }
            }} />
          </Field>
          {photo ? <a className="text-xs text-primary underline" href={photo} target="_blank" rel="noreferrer">Slip uploaded</a> : null}
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <RejectionBanner error={error} />
          <Button disabled={busy} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const a = parseRupees(amount);
              if (!a) throw new ApiError("VALIDATION_FAILED", "Enter the amount in ₹.", 422, null);
              await api("/api/finance/safe", { body: { amount: a, depositDate: date, slipRef: slip, photoUrl: photo, note: note || undefined } });
              setAmount(""); setSlip(""); setNote(""); setPhoto(null);
              onOpenChange(false);
              onDone();
            } catch (e) {
              setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
            } finally {
              setBusy(false);
            }
          }}>{busy ? "Saving…" : "Record deposit"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SafePanel({ canDeposit }: { canDeposit: boolean }) {
  const state = useApi<Safe>(canDeposit ? "/api/finance/safe" : null);
  const [open, setOpen] = useState(false);
  if (!canDeposit) return null;
  return (
    <DataState state={state}>
      {(s) => (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Safe · <span data-testid="safe-balance">{formatINR(s.balance)}</span></CardTitle>
            <Button size="sm" onClick={() => setOpen(true)}>Record bank deposit</Button>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Safe movements</h3>
              {s.movements.length === 0 ? <Empty title="Nothing in the safe yet" /> : (
                <Table>
                  <THead><TR><TH>When</TH><TH>What</TH><TH className="text-right">Amount</TH><TH className="text-right">Safe</TH></TR></THead>
                  <TBody>
                    {s.movements.slice(0, 15).map((m) => (
                      <TR key={m.id}>
                        <TD className="whitespace-nowrap text-xs">{fmtDateTime(m.at)}</TD>
                        <TD className="text-sm">{SAFE_LABEL[m.type] ?? m.type}{m.reference ? ` · ${m.reference}` : ""}{m.actor ? <span className="block text-xs text-muted-foreground">{m.actor}{m.note ? ` · ${m.note}` : ""}</span> : null}</TD>
                        <TD className="text-right"><Money paise={m.amount} /></TD>
                        <TD className="text-right"><Money paise={m.balanceAfter} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Bank deposits</h3>
              {s.deposits.length === 0 ? <Empty title="No bank deposits yet" /> : (
                <Table>
                  <THead><TR><TH>Date</TH><TH>Slip</TH><TH className="text-right">Amount</TH></TR></THead>
                  <TBody>
                    {s.deposits.slice(0, 15).map((d) => (
                      <TR key={d.id}>
                        <TD className="whitespace-nowrap text-xs">{fmtDate(d.depositDate)}</TD>
                        <TD className="text-sm">{d.slipRef}{d.photoUrl ? <> · <a className="text-primary underline" href={d.photoUrl} target="_blank" rel="noreferrer">photo</a></> : null}{d.source === "SESSION" ? <span className="block text-xs text-muted-foreground">from a drawer closed before the safe was kept</span> : null}</TD>
                        <TD className="text-right"><Money paise={d.amount} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
            <DepositDialog open={open} onOpenChange={setOpen} safe={s.balance} onDone={() => void state.reload()} />
          </CardContent>
        </Card>
      )}
    </DataState>
  );
}

export function DrawersOverview() {
  const state = useApi<Overview>("/api/finance/drawers", { pollMs: 10_000 });
  return (
    <DataState state={state}>
      {(o) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Cash collected today" paise={o.collectedTodayPaise} />
            <Tile label="Cash in drawers now" paise={o.inDrawersNowPaise} testId="cash-in-drawers" />
            <Tile label="Cash in the safe" paise={o.inSafePaise} />
            <div className="flex flex-col rounded-2xl border bg-card p-3 shadow-soft">
              <span className="text-xs font-semibold text-muted-foreground">Variances awaiting approval</span>
              <span className="font-display text-2xl font-bold tabular">{o.pendingApprovals}</span>
            </div>
          </div>
          {o.tills.length === 0 ? (
            <Empty title="No tills yet" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="tills">
              {o.tills.map((t) => (
                <Card key={t.id} className={t.active ? "" : "opacity-60"}>
                  <CardContent className="flex flex-col gap-2 pt-5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{t.name}</span>
                      {t.open ? <Badge tone="green">Open</Badge> : t.active ? <Badge tone="neutral">Closed</Badge> : <Badge tone="neutral">Retired</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground">{LOCATION[t.location] ?? t.location} · default float {formatINR(t.defaultFloat)}</span>
                    {t.open ? (
                      <Link href={`/app/finance/drawers/${t.open.sessionId}`} className="flex flex-col rounded-xl bg-secondary/60 p-2 hover:bg-secondary">
                        <span className="text-xs text-muted-foreground">{t.open.staff} · since {fmtDateTime(t.open.since)}</span>
                        <span className="font-display text-2xl font-bold tabular">{formatINR(t.open.balance)}</span>
                      </Link>
                    ) : t.lastClose ? (
                      <Link href={`/app/finance/drawers/${t.lastClose.sessionId}`} className="text-xs text-muted-foreground hover:underline">
                        Last closed {fmtDateTime(t.lastClose.at)} · {formatINR(t.lastClose.floatCarried ?? 0)} left in the till
                        {t.lastClose.status === "PENDING_APPROVAL" ? " · variance awaiting approval" : ""}
                      </Link>
                    ) : <span className="text-xs text-muted-foreground">Never opened</span>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <SafePanel canDeposit={o.canDeposit} />
        </div>
      )}
    </DataState>
  );
}
