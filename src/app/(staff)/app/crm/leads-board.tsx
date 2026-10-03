"use client";
import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { fmtDateTime } from "@/lib/time";
import { STATUSES, type LeadRow } from "./types";

const COL_TITLE: Record<string, string> = { NEW: "New", CONTACTED: "Contacted", QUOTED: "Quoted", WON: "Won", LOST: "Lost" };

function NewLeadDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", email: "", source: "WALK_IN", interest: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4" /> New lead</Button>
      </DialogTrigger>
      <DialogContent title="New lead" description="Walk-ins, phone calls and referrals. Website enquiries and trials arrive automatically.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/api/crm/leads", { body: { ...f, phone: f.phone || undefined, email: f.email || undefined } });
              setOpen(false);
              setF({ name: "", phone: "", email: "", source: "WALK_IN", interest: "", message: "" });
              onCreated();
            } catch (err) {
              setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" /></Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Source">
              <Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
                <option value="WALK_IN">Walk-in</option>
                <option value="PHONE">Phone</option>
                <option value="REFERRAL">Referral</option>
              </Select>
            </Field>
            <Field label="Interest"><Input value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} placeholder="e.g. Gold membership" /></Field>
          </div>
          <Field label="Notes"><Textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Create lead"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LeadsBoard() {
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const url = `/api/crm/leads?${mine ? "mine=1&" : ""}${q.trim() ? `q=${encodeURIComponent(q.trim())}` : ""}`;
  const state = useApi<LeadRow[]>(url, { pollMs: 30_000 });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search name, phone or LD-000123" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="h-4 w-4" /> Only mine
        </label>
        <div className="ml-auto"><NewLeadDialog onCreated={() => void state.reload()} /></div>
      </div>
      <DataState state={state}>
        {(rows) => {
          const overdue = rows.filter((r) => r.overdue).length;
          return (
            <div className="flex flex-col gap-3">
              <div className={cn("flex items-center gap-2 rounded-md border p-2 text-sm", overdue ? "border-red-300 bg-red-50 text-red-900" : "bg-card")}>
                <AlertTriangle className={cn("h-4 w-4", overdue ? "text-destructive" : "text-muted-foreground")} />
                <strong>{overdue}</strong> overdue follow-up{overdue === 1 ? "" : "s"} · {rows.length} lead{rows.length === 1 ? "" : "s"} shown
              </div>
              <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
                {STATUSES.map((s) => {
                  const col = rows.filter((r) => r.status === s);
                  return (
                    <div key={s} className="flex flex-col gap-2 rounded-lg bg-muted/60 p-2">
                      <p className="flex items-center justify-between px-1 text-sm font-semibold">{COL_TITLE[s]} <Badge>{col.length}</Badge></p>
                      {col.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">No leads</p> : null}
                      {col.map((l) => (
                        <Link
                          key={l.id}
                          href={`/app/crm/${l.id}`}
                          className={cn("flex flex-col gap-1 rounded-md border bg-card p-2 text-sm shadow-sm hover:shadow-md", l.overdue && "border-red-400 bg-red-50")}
                          data-testid="lead-card"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{l.name}</span>
                            {l.overdue ? <Badge tone="red">Overdue</Badge> : null}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">{l.code} · {l.source.replace(/_/g, " ").toLowerCase()}</span>
                          {l.interest ? <span className="text-xs">{l.interest}</span> : null}
                          <span className="text-xs text-muted-foreground">{l.assignee ? `→ ${l.assignee}` : "Unassigned"}</span>
                          {s !== "WON" && s !== "LOST" ? (
                            <span className={cn("text-xs", l.overdue ? "font-semibold text-destructive" : "text-muted-foreground")}>Follow up {fmtDateTime(l.nextFollowUpAt)}</span>
                          ) : s === "LOST" && l.lostReason ? (
                            <span className="text-xs text-muted-foreground">{l.lostReason}</span>
                          ) : null}
                        </Link>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
