"use client";
// v3 §3.2: social play with the standard FilterBar and summary strip; the sessions are still shown as a board of
// cards (create, add player, take the fee, check in, remove, cancel) — now filtered and paged on the server.
import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, newIdempotencyKey, useApi } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ConfirmButton } from "@/components/confirm";
import { PaymentPanel } from "@/components/payment-panel";
import { emptyTender, MethodSelect, ProofFields, tenderProof, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { addDays, fmtDay, fmtRange, istDate, minutesToTime, timeToMinutes } from "@/lib/time";
import { PlayerPicker } from "../_components/player-picker";
import { errorOf, type PickedPlayer } from "../_components/types";
import { useNow } from "../_components/use-now";

type Participant = { id: string; name: string; memberId: string | null; tier: string; fee: number; checkedInAt: string | null; billId: string | null };
type Row = {
  id: string; title: string; series_id: string | null; start_at: string; end_at: string; status: string; capacity: number; joined: number;
  free: number; courts: string | null; checked_in: number; due: number; fees: number; participants: Participant[];
};
type Perms = { manage: boolean; book: boolean; checkin: boolean };

const TIMES = Array.from({ length: 33 }, (_, i) => minutesToTime(timeToMinutes("06:00") + i * 30));

function nextFriday(today: string) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (5 - dow + 7) % 7);
}

function CreateSession({ today, onDone }: { today: string; onDone: () => void }) {
  const courts = useApi<Array<{ id: string; name: string; active: boolean }>>("/api/courts");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Friday Social");
  const [picked, setPicked] = useState<string[]>([]);
  const [date, setDate] = useState(nextFriday(today));
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("22:00");
  const [capacity, setCapacity] = useState("12");
  const [weeks, setWeeks] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> Create social session</Button></DialogTrigger>
      <DialogContent title="Create social session" description="Template: Fridays 19:00–22:00. A session can't be created over existing bookings — conflicts are listed." wide>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/api/social", { body: { title, courtIds: picked, date, startTime: start, endTime: end, capacityPerCourt: Number(capacity), repeatWeeks: Number(weeks) } });
              setOpen(false);
              onDone();
            } catch (err) {
              setError(errorOf(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
          <div>
            <p className="mb-1 text-sm font-medium">Courts</p>
            <div className="flex flex-wrap gap-2">
              {(courts.data ?? []).filter((c) => c.active).map((c) => (
                <label key={c.id} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Field label="First date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
            <Field label="Start"><Select value={start} onChange={(e) => setStart(e.target.value)}>{TIMES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="End"><Select value={end} onChange={(e) => setEnd(e.target.value)}>{TIMES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="Capacity / court"><Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} /></Field>
            <Field label="Repeat weekly (weeks)"><Input type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(e.target.value)} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy || picked.length === 0}>{busy ? "Creating…" : "Create"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ParticipantBill({ billId, onPaid }: { billId: string; onPaid: () => void }) {
  const bill = useApi<{ due: number; status: string }>(`/api/bills/${billId}`);
  const [open, setOpen] = useState(false);
  if (!bill.data) return <span className="text-xs text-muted-foreground">…</span>;
  if (bill.data.due <= 0) return <StatusBadge status={bill.data.status} />;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { void bill.reload(); onPaid(); } }}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Pay <Money paise={bill.data.due} /></Button></DialogTrigger>
      <DialogContent title="Social play fee" wide><PaymentPanel billId={billId} onPaid={onPaid} /></DialogContent>
    </Dialog>
  );
}

function AddPlayer({ session, onDone }: { session: { id: string; title: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [players, setPlayers] = useState<PickedPlayer[]>([]);
  const [payNow, setPayNow] = useState(false);
  const methods = useTenderMethods() ?? ["CASH"];
  const [tender, setTender] = useState<TenderDraft>(emptyTender("CASH"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setPlayers([]); setError(null); setDone(null); } }}>
      <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" /> Add player</Button></DialogTrigger>
      <DialogContent title={`Add a player to ${session.title}`} description="Capacity, the daily play limit, time conflicts and the booking window are checked on the server." wide>
        <div className="flex flex-col gap-3">
          <PlayerPicker players={players} onChange={setPlayers} max={1} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} /> Take payment now</label>
          {payNow ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <MethodSelect methods={methods} value={tender.method} onChange={(m) => setTender({ ...tender, method: m })} />
              <ProofFields className="sm:col-span-2" value={tender} onChange={(patch) => setTender({ ...tender, ...patch })} />
            </div>
          ) : null}
          <RejectionBanner error={error} />
          {done ? <p className="rounded-md border border-green-300 bg-green-50 p-2 text-sm">{done}</p> : null}
          <Button
            disabled={busy || players.length !== 1}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ name: string; fee: number; explanation: string; due: number }>(`/api/social/${session.id}/join`, {
                  body: { player: players[0].input, payment: payNow ? { kind: "COUNTER", ...tenderProof(tender) } : { kind: "LATER" } },
                  idempotencyKey: newIdempotencyKey(),
                });
                setDone(`${r.name} joined — ${r.explanation}${r.due > 0 ? " (fee due at check-in)" : ""}.`);
                setPlayers([]);
                onDone();
              } catch (err) {
                setError(errorOf(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Adding…" : "Join session"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CheckInSocial({ id, onDone }: { id: string; onDone: () => void }) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" onClick={async () => {
        setError(null);
        try { await api("/api/checkin", { body: { socialParticipantId: id } }); onDone(); } catch (e) { setError(errorOf(e)); }
      }}>Check in</Button>
      <RejectionBanner error={error} />
    </div>
  );
}

function SessionCard({ s, perms }: { s: Row; perms: Perms }) {
  const reload = useListReload();
  const now = useNow();
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>{s.title} · {fmtDay(istDate(new Date(s.start_at)))} {fmtRange(s.start_at, s.end_at)}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {s.courts ?? "—"} · {s.joined}/{s.capacity} players{s.series_id ? " · weekly series" : ""}
            {s.due > 0 ? <> · <Money paise={s.due} /> to collect</> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={s.status} />
          {s.status === "SCHEDULED" && perms.book ? <AddPlayer session={s} onDone={reload} /> : null}
          {s.status === "SCHEDULED" && perms.manage ? (
            <ConfirmButton trigger="Cancel session" title={`Cancel ${s.title}?`} description="Every participant is refunded and the courts are released." requireReason confirmLabel="Cancel session"
              onConfirm={async (reason) => { await api(`/api/social/${s.id}/cancel`, { body: { reason } }); reload(); }} />
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {s.participants.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
        ) : (
          <Table>
            <THead><TR><TH>Player</TH><TH>Tier</TH><TH>Fee</TH><TH>Payment</TH><TH>Check-in</TH><TH /></TR></THead>
            <TBody>
              {s.participants.map((p) => (
                <TR key={p.id}>
                  <TD className="font-medium">{p.name}</TD>
                  <TD><TierBadge tier={p.tier} /></TD>
                  <TD><Money paise={p.fee} /></TD>
                  <TD>{p.billId ? <ParticipantBill billId={p.billId} onPaid={reload} /> : "—"}</TD>
                  <TD>{p.checkedInAt ? <span className="text-xs text-green-700">Checked in</span> : perms.checkin && s.status === "SCHEDULED" ? <CheckInSocial id={p.id} onDone={reload} /> : "—"}</TD>
                  <TD>
                    {perms.book && s.status === "SCHEDULED" && new Date(s.start_at).getTime() > now ? (
                      <ConfirmButton trigger="Remove" title={`Remove ${p.name}?`} description="Leaving 2 h or more before start refunds the fee in cash from your drawer (online payments go back online) (BK-7)." confirmLabel="Remove player"
                        onConfirm={async () => { await api(`/api/social/participants/${p.id}/leave`, { body: { refundMethod: "CASH" } }); reload(); }} />
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CreateSessionButton({ today }: { today: string }) {
  const reload = useListReload();
  return <CreateSession today={today} onDone={reload} />;
}

export function SocialBoard({ today, perms }: { today: string; perms: Perms }) {
  return (
    <FilteredList<Row>
      list="social"
      searchPlaceholder="Session, court or player"
      pollMs={15_000}
      toolbar={
        <>
          <Button asChild variant="outline"><Link href="/app/courts/social/players">All players</Link></Button>
          {perms.manage ? <CreateSessionButton today={today} /> : null}
        </>
      }
      columns={[]}
      view={(rows) => <div className="flex flex-col gap-3">{rows.map((s) => <SessionCard key={s.id} s={s} perms={perms} />)}</div>}
      empty={{ title: "No social sessions scheduled", hint: perms.manage ? "Create the Friday social series above." : "A manager can schedule one." }}
    />
  );
}
