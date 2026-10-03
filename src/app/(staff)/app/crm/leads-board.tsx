"use client";
import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
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

type ListLead = {
  id: string; code: string; name: string; phone: string | null; status: LeadRow["status"]; source: string; interest: string;
  assignee: string | null; next_follow_up_at: string; overdue: boolean; lost_reason: string | null;
};

/** "Follow up — overdue 2 days" / "Follow up tomorrow". */
function FollowUp({ l }: { l: ListLead }) {
  if (l.status === "WON" || l.status === "LOST") return l.status === "LOST" && l.lost_reason ? <span className="text-xs text-muted-foreground">{l.lost_reason}</span> : null;
  return (
    <span className={cn("text-xs font-semibold", l.overdue ? "text-destructive" : "text-muted-foreground")}>
      Follow up{l.overdue ? " — overdue " : " "}
      <RelTime when={l.next_follow_up_at} />
    </span>
  );
}

function Board({ rows }: { rows: ListLead[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
      {STATUSES.map((s) => {
        const col = rows.filter((r) => r.status === s);
        return (
          <div key={s} className="flex flex-col gap-2 rounded-2xl bg-secondary/70 p-2">
            <p className="flex items-center justify-between px-1 text-sm font-bold">{COL_TITLE[s]} <span className="rounded-full bg-card px-2 text-xs tabular">{col.length}</span></p>
            {col.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">No leads</p> : null}
            {col.map((l) => (
              <Link
                key={l.id}
                href={`/app/crm/${l.id}`}
                className={cn("flex flex-col gap-1 rounded-xl border bg-card p-2.5 text-sm shadow-soft hover:border-primary", l.overdue && "border-destructive/50")}
                data-testid="lead-card"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{l.name}</span>
                  {l.overdue ? <Badge tone="red">Overdue</Badge> : null}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{l.code} · {l.source.replace(/_/g, " ").toLowerCase()}</span>
                {l.interest ? <span className="text-xs">{l.interest}</span> : null}
                <span className="text-xs text-muted-foreground">{l.assignee ? `→ ${l.assignee}` : "Unassigned"}</span>
                <FollowUp l={l} />
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function LeadsBoard() {
  const [layout, setLayout] = useState<"board" | "list">("board");
  return (
    <FilteredList<ListLead>
      list="leads"
      searchPlaceholder="Name, mobile or LD-000123"
      pollMs={30_000}
      toolbar={
        <>
          <div className="inline-flex rounded-full bg-secondary p-1" role="group" aria-label="Layout">
            {(["board", "list"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setLayout(v)} aria-pressed={layout === v} className={cn("rounded-full px-3 py-1 text-sm font-semibold", layout === v ? "bg-primary text-primary-foreground" : "text-secondary-foreground")}>
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
          <NewLeadDialog onCreated={() => window.location.reload()} />
        </>
      }
      view={layout === "board" ? (rows) => <Board rows={rows} /> : undefined}
      columns={[
        { key: "name", header: "Lead", cell: (l) => (
          <span className="flex flex-col">
            <Link href={`/app/crm/${l.id}`} className="font-semibold text-primary hover:underline">{l.name}</Link>
            <span className="font-mono text-xs text-muted-foreground">{l.code}</span>
          </span>
        ) },
        { key: "status", header: "Status", cell: (l) => <Badge tone={l.status === "WON" ? "green" : l.status === "LOST" ? "neutral" : "blue"}>{COL_TITLE[l.status]}</Badge> },
        { key: "source", header: "Source", cell: (l) => <span className="text-sm">{l.source.replace(/_/g, " ").toLowerCase()}</span> },
        { key: "interest", header: "Interest", cell: (l) => <span className="text-sm">{l.interest || "—"}</span> },
        { key: "assignee", header: "Assignee", cell: (l) => <span className="text-sm">{l.assignee ?? "Unassigned"}</span> },
        { key: "next", header: "Next", cell: (l) => <FollowUp l={l} /> },
      ]}
      empty={{ title: "No leads match", hint: "Remove a filter to see more leads." }}
    />
  );
}
