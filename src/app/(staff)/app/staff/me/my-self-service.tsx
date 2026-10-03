"use client";
import { useState } from "react";
import { Clock, LogOut } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDate, fmtDateTime, fmtRange, fmtDay } from "@/lib/time";
import { parseRupees } from "@/lib/money";
import type { StaffMe } from "../../bar/_components/types";

type Rejection = { code?: string; message: string } | null;
const rej = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function ClockCard({ me, reload }: { me: StaffMe; reload: () => void }) {
  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); reload(); } catch (e) { setError(rej(e)); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-4 w-4" /> Attendance</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {done ? <p className="rounded-md border border-success/40 bg-success/10 p-2 text-sm">{done}</p> : null}
        {me.clockedIn ? (
          <>
            <p className="text-sm">Clocked in since <strong>{fmtDateTime(me.clockedIn.since)}</strong> · opening float <Money paise={me.clockedIn.openingFloat} /></p>
            <p className="text-sm text-muted-foreground">Cash expected in your drawer so far: <Money paise={me.clockedIn.cashExpected} className="font-semibold text-foreground" /></p>
            <Field label="Cash counted (₹)" hint="Count the drawer. Any difference is recorded as a variance.">
              <Input inputMode="decimal" className="h-12 text-lg" value={counted} onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Button
              size="lg"
              variant="destructive"
              disabled={busy}
              onClick={() => run(async () => {
                const c = counted ? parseRupees(counted) : null;
                if (counted && c === null) throw new ApiError("VALIDATION_FAILED", "Cash counted is not a valid amount.", 422, null);
                const a = await api<{ cashExpected: number | null; cashCounted: number | null; variance: number | null }>("/api/staff/clock-out", { body: c === null ? {} : { cashCounted: c } });
                setCounted("");
                setDone(a.variance === null ? "Clocked out." : `Clocked out. Expected ₹${((a.cashExpected ?? 0) / 100).toFixed(2)}, counted ₹${((a.cashCounted ?? 0) / 100).toFixed(2)}, variance ₹${(a.variance / 100).toFixed(2)}.`);
              })}
            >
              <LogOut className="h-4 w-4" /> Clock out
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">You are not clocked in.</p>
            <Field label="Opening float (₹)" hint="Cash in the drawer when you start; 0 if you don't handle cash.">
              <Input inputMode="decimal" className="h-12 text-lg" value={float} onChange={(e) => setFloat(e.target.value)} />
            </Field>
            <Button size="lg" disabled={busy} onClick={() => run(async () => {
              await api("/api/staff/clock-in", { body: { openingFloat: float ? (parseRupees(float) ?? 0) : 0 } });
              setFloat("");
              setDone(null);
            })}>Clock in</Button>
          </>
        )}
        <RejectionBanner error={error} />
      </CardContent>
    </Card>
  );
}

function LeaveForm({ reload, today }: { reload: () => void; today: string }) {
  const [type, setType] = useState("CASUAL");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [ok, setOk] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setOk(false);
        try {
          await api("/api/staff/leave", { body: { type, startDate: start, endDate: end || start, reason } });
          setReason(""); setStart(""); setEnd(""); setOk(true);
          reload();
        } catch (err) {
          setError(rej(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="CASUAL">Casual</option><option value="SICK">Sick</option><option value="UNPAID">Unpaid</option>
          </Select>
        </Field>
        <Field label="From"><Input type="date" min={today} value={start} onChange={(e) => setStart(e.target.value)} required /></Field>
        <Field label="To"><Input type="date" min={start || today} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="Reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} /></Field>
      <RejectionBanner error={error} />
      {ok ? <p className="text-sm text-success-text">Request sent to the manager.</p> : null}
      <Button type="submit" disabled={busy}>Request leave</Button>
    </form>
  );
}

export function MySelfService() {
  const state = useApi<StaffMe>("/api/staff/me");
  const reload = () => void state.reload();
  return (
    <DataState state={state}>
      {(me) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <ClockCard me={me} reload={reload} />
          <Card>
            <CardHeader><CardTitle>My upcoming shifts</CardTitle></CardHeader>
            <CardContent>
              {me.shifts.length === 0 ? <Empty title="No shifts rostered" /> : (
                <div className="divide-y">
                  {me.shifts.map((s) => (
                    <div key={s.id} className="flex items-center justify-between py-2 text-sm">
                      <span>{fmtDay(s.date)} · {fmtRange(s.startAt, s.endAt)}</span>
                      <span className="flex gap-1"><Badge tone="blue">{s.area.replace("_", " ")}</Badge><StatusBadge status={s.status} /></span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Request leave</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md border p-2">Casual: <strong>{me.allowance.CASUAL.total - me.allowance.CASUAL.used}</strong> of {me.allowance.CASUAL.total} left</div>
                <div className="rounded-md border p-2">Sick: <strong>{me.allowance.SICK.total - me.allowance.SICK.used}</strong> of {me.allowance.SICK.total} left</div>
              </div>
              <LeaveForm reload={reload} today={me.today} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>My leave requests</CardTitle></CardHeader>
            <CardContent>
              {me.leave.length === 0 ? <Empty title="No leave requested yet" /> : (
                <Table><THead><TR><TH>Dates</TH><TH>Type</TH><TH>Days</TH><TH>Status</TH></TR></THead>
                  <TBody>{me.leave.map((l) => (
                    <TR key={l.id}>
                      <TD>{fmtDate(l.startDate)} – {fmtDate(l.endDate)}{l.decisionNote ? <p className="text-xs text-muted-foreground">{l.decisionNote}</p> : null}</TD>
                      <TD>{l.type}</TD><TD>{l.days}</TD><TD><StatusBadge status={l.status} /></TD>
                    </TR>))}
                  </TBody></Table>
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Recent attendance</CardTitle></CardHeader>
            <CardContent>
              {me.attendance.length === 0 ? <Empty title="No attendance yet" /> : (
                <Table><THead><TR><TH>In</TH><TH>Out</TH><TH>Cash expected</TH><TH>Counted</TH><TH>Variance</TH></TR></THead>
                  <TBody>{me.attendance.map((a) => (
                    <TR key={a.id}>
                      <TD>{fmtDateTime(a.clockIn)}</TD><TD>{a.clockOut ? fmtDateTime(a.clockOut) : "—"}</TD>
                      <TD>{a.cashExpected !== null ? <Money paise={a.cashExpected} /> : "—"}</TD>
                      <TD>{a.cashCounted !== null ? <Money paise={a.cashCounted} /> : "—"}</TD>
                      <TD>{a.variance !== null ? <Money paise={a.variance} /> : "—"}</TD>
                    </TR>))}
                  </TBody></Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </DataState>
  );
}
