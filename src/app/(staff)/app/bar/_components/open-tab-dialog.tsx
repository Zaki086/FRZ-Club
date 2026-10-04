"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { api, newIdempotencyKey, useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { checkContactInputs, PhoneInput } from "@/components/contact-inputs";
import { RejectionBanner } from "@/components/states";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { cn } from "@/components/ui/cn";
import type { TableRow } from "./types";
import { toRejection, type Rejection } from "./err";

type Hit = { id: string; memberCode: string; name: string; phone: string; status: MemberStatus };

export function OpenTabDialog({ tables, defaultTableId, trigger }: { tables: TableRow[]; defaultTableId?: string | null; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"member" | "guest">("member");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [member, setMember] = useState<Hit | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [idOk, setIdOk] = useState(false);
  const [tableId, setTableId] = useState<string>(defaultTableId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useApi<Hit[]>(mode === "member" && term.length >= 2 ? `/api/members?q=${encodeURIComponent(term)}` : null);

  const reset = () => {
    setQ(""); setMember(null); setGuestName(""); setGuestPhone(""); setIdOk(false); setError(null); setKey(newIdempotencyKey());
    setTableId(defaultTableId ?? "");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? <Button size="lg"><Plus className="h-5 w-5" /> Open tab</Button>}
      </DialogTrigger>
      <DialogContent title="Open a tab">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={mode === "member" ? "default" : "outline"} size="lg" onClick={() => setMode("member")}>Member</Button>
            <Button variant={mode === "guest" ? "default" : "outline"} size="lg" onClick={() => setMode("guest")}>Guest</Button>
          </div>
          {mode === "member" ? (
            member ? (
              <div className="flex items-center justify-between rounded-md border bg-accent/40 p-3">
                <div>
                  <p className="font-semibold">{member.name}</p>
                  <p className="text-xs text-muted-foreground">{member.memberCode} · {member.phone}</p>
                  <MemberStatusBadge status={member.status} />
                </div>
                <Button variant="ghost" size="sm" onClick={() => setMember(null)}>Change</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Input autoFocus className="h-12 text-base" placeholder="Name, phone or CC-000123" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="max-h-56 divide-y overflow-y-auto rounded-md border">
                  {term.length < 2 ? <p className="p-3 text-sm text-muted-foreground">Type at least 2 characters.</p> : hits.error ? (
                    <p className="p-3 text-sm text-destructive">{hits.error.message}</p>
                  ) : !hits.data ? <p className="p-3 text-sm text-muted-foreground">Searching…</p> : hits.data.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">No member found.</p>
                  ) : hits.data.map((h) => (
                    <button key={h.id} type="button" className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-muted" onClick={() => setMember(h)}>
                      <span><span className="font-medium">{h.name}</span> <span className="text-xs text-muted-foreground">{h.memberCode}</span></span>
                      <MemberStatusBadge status={h.status} />
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <Field label="Guest name *"><Input autoFocus className="h-12 text-base" value={guestName} onChange={(e) => setGuestName(e.target.value)} /></Field>
              <Field label="Phone (optional)"><PhoneInput name="guestPhone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} /></Field>
              <label className={cn("flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm", idOk && "border-primary bg-accent")}>
                <input type="checkbox" className="h-5 w-5" checked={idOk} onChange={(e) => setIdOk(e.target.checked)} />
                ID verified 18+ (required before serving alcohol to a guest)
              </label>
            </div>
          )}
          <Field label="Table">
            <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">No table (bar counter)</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>Table {t.number} · {t.area} · {t.status === "OCCUPIED" ? `${t.tabs.length} tab(s)` : "free"}</option>
              ))}
            </Select>
          </Field>
          <RejectionBanner error={error} />
          <Button
            size="xl"
            disabled={busy || (mode === "member" ? !member : guestName.trim().length < 2)}
            onClick={async (e) => {
              if (!checkContactInputs(e.currentTarget.parentElement)) return;
              setBusy(true);
              setError(null);
              try {
                const body = mode === "member"
                  ? { memberId: member!.id, tableId: tableId || null }
                  : { guest: { name: guestName.trim(), phone: guestPhone.trim() || undefined }, tableId: tableId || null, guestIdVerified: idOk };
                const r = await api<{ tabId: string }>("/api/bar/tabs", { body, idempotencyKey: key });
                setOpen(false);
                router.push(`/app/bar/tabs/${r.tabId}`);
              } catch (e) {
                setError(toRejection(e));
                setKey(newIdempotencyKey());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Opening…" : "Open tab"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
