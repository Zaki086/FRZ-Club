"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Copy, Phone, Plus, Trash2, UserPlus } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { ConfirmButton } from "@/components/confirm";
import { Money } from "@/components/money";
import { formatINR, parseRupees } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import type { LeadDetail } from "../types";
import { WhatsAppButton } from "@/components/whatsapp-button";
import { useCapabilities } from "@/components/capabilities";

type Plan = { code: string; name: string; price1m: number; price3m: number; price12m: number };
type QLine = { kind: "PLAN"; planCode: string; months: 1 | 3 | 12 } | { kind: "CUSTOM"; description: string; amount: string };

const toErr = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function ActivityForm({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const [type, setType] = useState("CALL");
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/api/crm/leads/${leadId}/activity`, { body: { type, note, nextFollowUpAt: next ? new Date(next).toISOString() : undefined } });
          setNote("");
          setNext("");
          onDone();
        } catch (err) {
          setError(toErr(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="CALL">Call</option>
            <option value="EMAIL">Email</option>
            <option value="NOTE">Note</option>
          </Select>
        </Field>
        <Field label="Next follow-up" hint="Empty = in 24 hours" className="sm:col-span-2">
          <Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
      <Field label="What happened"><Textarea value={note} onChange={(e) => setNote(e.target.value)} required /></Field>
      <RejectionBanner error={error} />
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Log activity"}</Button>
    </form>
  );
}

function QuoteBuilder({ leadId, hasEmail, onDone }: { leadId: string; hasEmail: boolean; onDone: () => void }) {
  const plans = useApi<Plan[]>("/api/plans");
  const [lines, setLines] = useState<QLine[]>([{ kind: "PLAN", planCode: "SILVER", months: 1 }]);
  const [validDays, setValidDays] = useState("7");
  const [send, setSend] = useState<"LINK" | "EMAIL">("LINK");
  const caps = useCapabilities();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<{ link: string; total: number; validUntil: string } | null>(null);
  const priceOf = (code: string, m: number) => {
    const p = plans.data?.find((x) => x.code === code);
    return p ? (m === 1 ? p.price1m : m === 3 ? p.price3m : p.price12m) : null;
  };
  const update = (i: number, l: QLine) => setLines(lines.map((x, j) => (j === i ? l : x)));
  if (result) {
    const abs = `${window.location.origin}${result.link}`;
    return (
      <div className="flex flex-col gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm">
        <p className="font-semibold">Quote created for {formatINR(result.total)} · valid until {fmtDateTime(result.validUntil)}</p>
        <div className="flex gap-2">
          <Input readOnly value={abs} onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(abs)}><Copy className="h-4 w-4" /> Copy</Button>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm"><a href={result.link} target="_blank" rel="noreferrer">Open quote page</a></Button>
          <Button size="sm" variant="ghost" onClick={() => setResult(null)}>New quote</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
          {l.kind === "PLAN" ? (
            <>
              <Field label="Plan" className="min-w-32 flex-1">
                <Select value={l.planCode} onChange={(e) => update(i, { ...l, planCode: e.target.value })}>
                  {(plans.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Duration" className="w-32">
                <Select value={l.months} onChange={(e) => update(i, { ...l, months: Number(e.target.value) as 1 | 3 | 12 })}>
                  <option value={1}>1 month</option>
                  <option value={3}>3 months</option>
                  <option value={12}>12 months</option>
                </Select>
              </Field>
              <p className="pb-2 text-xs text-muted-foreground">List price {priceOf(l.planCode, l.months) !== null ? formatINR(priceOf(l.planCode, l.months)!) : "—"}</p>
            </>
          ) : (
            <>
              <Field label="Description" className="min-w-40 flex-1"><Input value={l.description} onChange={(e) => update(i, { ...l, description: e.target.value })} /></Field>
              <Field label="Amount ₹ (GST incl.)" className="w-36"><Input inputMode="decimal" value={l.amount} onChange={(e) => update(i, { ...l, amount: e.target.value })} /></Field>
            </>
          )}
          <Button type="button" variant="ghost" size="icon" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { kind: "PLAN", planCode: "GOLD", months: 1 }])}><Plus className="h-4 w-4" /> Plan line</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { kind: "CUSTOM", description: "", amount: "" }])}><Plus className="h-4 w-4" /> Custom line</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Valid for (days)"><Input inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value)} /></Field>
        <Field label="Send">
          <Select value={send} onChange={(e) => setSend(e.target.value as "LINK" | "EMAIL")}>
            <option value="LINK">Copyable link</option>
            {caps?.email ? <option value="EMAIL" disabled={!hasEmail}>Email to the lead{hasEmail ? "" : " (no email)"}</option> : null}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">The total is calculated by the server from the plan prices when you create the quote.</p>
      <RejectionBanner error={error} />
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const body = {
              lines: lines.map((l) => {
                if (l.kind === "PLAN") return { planCode: l.planCode, months: l.months };
                const amount = parseRupees(l.amount);
                if (amount === null || !l.description.trim()) throw new ApiError("VALIDATION_FAILED", "Each custom line needs a description and an amount.", 422, null);
                return { description: l.description.trim(), amount };
              }),
              validDays: Number(validDays) || undefined,
              send,
            };
            setResult(await api(`/api/crm/leads/${leadId}/quote`, { body }));
            onDone();
          } catch (e) {
            setError(toErr(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Creating…" : "Create & send quote"}
      </Button>
    </div>
  );
}

export function LeadDetailView({ leadId, canConvert }: { leadId: string; canConvert: boolean }) {
  const router = useRouter();
  const state = useApi<LeadDetail>(`/api/crm/leads/${leadId}`);
  const [assignError, setAssignError] = useState<{ code?: string; message: string } | null>(null);
  const reload = () => void state.reload();
  return (
    <DataState state={state}>
      {(l) => {
        const open = l.status !== "WON" && l.status !== "LOST";
        return (
          <div className="flex flex-col gap-4">
            <Link href="/app/crm" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="h-4 w-4" /> Leads board</Link>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">{l.name}</h1>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-mono">{l.code}</span>
                  <span>{l.source.replace(/_/g, " ").toLowerCase()}</span>
                  {l.phone ? <a className="inline-flex items-center gap-1 text-primary" href={`tel:${l.phone}`}><Phone className="h-3 w-3" />{l.phone}</a> : null}
                  {l.email ? <a className="text-primary" href={`mailto:${l.email}`}>{l.email}</a> : null}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={l.status} />
                  {l.overdue ? <Badge tone="red">Overdue</Badge> : null}
                  {open ? <span className={l.overdue ? "text-sm font-semibold text-destructive" : "text-sm text-muted-foreground"}>Follow up by {fmtDateTime(l.nextFollowUpAt)}</span> : null}
                  {l.interest ? <Badge tone="blue">{l.interest}</Badge> : null}
                </div>
                {l.status === "LOST" && l.lostReason ? <p className="text-sm">Lost: {l.lostReason}</p> : null}
                {l.memberId ? <Link className="text-sm text-primary underline" href={`/app/members/${l.memberId}`}>Open member profile</Link> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {l.phone ? <WhatsAppButton target={{ template: "LEAD", leadId: l.id }} /> : null}
                {open && canConvert ? (
                  <Button onClick={() => router.push(l.convertUrl)} data-testid="convert-lead"><UserPlus className="h-4 w-4" /> Convert to member</Button>
                ) : null}
                {open ? (
                  <ConfirmButton
                    trigger="Mark lost"
                    title="Mark lead as lost"
                    description="Leads are never deleted; a reason is required (CR-2)."
                    requireReason
                    confirmLabel="Mark lost"
                    onConfirm={async (reason) => {
                      await api(`/api/crm/leads/${leadId}/lost`, { body: { reason } });
                      reload();
                    }}
                  />
                ) : null}
              </div>
            </div>
            {l.message ? <Card><CardContent className="pt-4 text-sm"><p className="text-xs uppercase text-muted-foreground">Their message</p>{l.message}</CardContent></Card> : null}
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="flex flex-col gap-4 lg:col-span-2">
                {open ? (
                  <Card>
                    <CardHeader><CardTitle>Log activity</CardTitle></CardHeader>
                    <CardContent><ActivityForm leadId={leadId} onDone={reload} /></CardContent>
                  </Card>
                ) : null}
                <Card>
                  <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
                  <CardContent>
                    {l.activities.length === 0 ? <Empty title="No activity yet" /> : (
                      <ol className="flex flex-col gap-3 border-l pl-4">
                        {l.activities.map((a) => (
                          <li key={a.id} className="relative text-sm">
                            <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                            <p className="flex flex-wrap items-center gap-2"><Badge>{a.type.replace(/_/g, " ")}</Badge><span className="text-xs text-muted-foreground">{fmtDateTime(a.at)} · {a.by}</span></p>
                            <p className="mt-0.5 whitespace-pre-wrap break-words">{a.note}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>
              </div>
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader><CardTitle>Assigned to</CardTitle></CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <Select
                      value={l.assignedTo ?? ""}
                      onChange={async (e) => {
                        setAssignError(null);
                        try {
                          await api(`/api/crm/leads/${leadId}/assign`, { body: { userId: e.target.value } });
                          reload();
                        } catch (err) {
                          setAssignError(toErr(err));
                        }
                      }}
                      aria-label="Assignee"
                    >
                      {!l.assignedTo ? <option value="">Unassigned</option> : null}
                      {l.assignable.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role.replace("_", " ").toLowerCase()})</option>)}
                    </Select>
                    <RejectionBanner error={assignError} />
                  </CardContent>
                </Card>
                {open ? (
                  <Card>
                    <CardHeader><CardTitle>Send a quote</CardTitle></CardHeader>
                    <CardContent><QuoteBuilder leadId={leadId} hasEmail={!!l.email} onDone={reload} /></CardContent>
                  </Card>
                ) : null}
                <Card>
                  <CardHeader><CardTitle>Quotes</CardTitle></CardHeader>
                  <CardContent>
                    {l.quotes.length === 0 ? <p className="text-sm text-muted-foreground">No quotes yet.</p> : (
                      <div className="flex flex-col divide-y">
                        {l.quotes.map((q) => (
                          <div key={q.id} className="flex flex-col gap-1 py-2 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <Money paise={q.total} className="font-semibold" />
                              {q.expired && q.status === "SENT" ? <Badge tone="red">Expired</Badge> : <StatusBadge status={q.status} />}
                            </div>
                            <p className="text-xs text-muted-foreground">{fmtDateTime(q.createdAt)} · valid until {fmtDateTime(q.validUntil)}</p>
                            <a className="text-xs text-primary underline" href={`/quote/${q.token}`} target="_blank" rel="noreferrer">Open quote page</a>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </DataState>
  );
}
