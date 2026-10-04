"use client";
// E-05 live court command centre: courts × 30-minute columns, colour-coded, refreshed every 10 s.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api, useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ConfirmButton } from "@/components/confirm";
import { cn } from "@/components/ui/cn";
import { addDays, fmtDay } from "@/lib/time";
import { BookingDialog, type NewBookingTarget } from "./booking-dialog";
import { BookingDetailDialog } from "./booking-detail";
import { MaintenanceDialog } from "./maintenance-dialog";
import { CloseCourtsDialog } from "./close-courts-dialog";
import type { Availability, CourtRow, PickedPlayer, Slot } from "./types";

type Perms = { book: boolean; maintenance: boolean; checkin: boolean; message?: boolean };

const STRIPES = "bg-[repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0_6px,#cbd5e1_6px,#cbd5e1_12px)]";

function cellClass(s: Slot) {
  if (s.state === "FREE") {
    if (s.bookable) return "bg-card hover:bg-success/10 hover:ring-2 hover:ring-primary cursor-pointer";
    return s.past ? "bg-secondary text-muted-foreground/60" : "bg-secondary text-muted-foreground/60";
  }
  if (s.state === "SOCIAL") return "bg-junior/20 text-junior hover:bg-junior/30 cursor-pointer";
  if (s.state === "MAINTENANCE") return `${STRIPES} text-foreground cursor-pointer`;
  if (s.checkedIn) return "bg-success/25 text-success-text hover:bg-success/35 cursor-pointer";
  if (s.unpaid) return "bg-warning/40 text-warning-foreground hover:bg-warning/60 cursor-pointer";
  return "bg-primary/15 text-primary hover:bg-primary/25 cursor-pointer";
}

/** Merge consecutive half-hour cells held by the same reservation into one block. */
function spans(slots: Slot[]) {
  const out: Array<{ slot: Slot; span: number }> = [];
  for (let i = 0; i < slots.length; ) {
    const s = slots[i];
    let j = i + 1;
    if (s.reservationId) while (j < slots.length && slots[j].reservationId === s.reservationId) j++;
    out.push({ slot: s, span: j - i });
    i = j;
  }
  return out;
}

function Legend() {
  const items: Array<[string, string]> = [
    ["bg-white border", "Free"],
    ["bg-primary/15", "Booked (paid)"],
    ["bg-warning/40", "Booked — payment due"],
    ["bg-success/25", "Checked in"],
    ["bg-junior/20", "Social play"],
    [STRIPES, "Maintenance"],
    ["bg-secondary", "Past / can't start"],
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1">
          <span className={cn("inline-block h-3 w-5 rounded-sm", c)} /> {l}
        </span>
      ))}
    </div>
  );
}

export function CommandCentre({ initialDate, perms, prefillMemberId }: { initialDate: string; perms: Perms; prefillMemberId: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const state = useApi<Availability>(`/api/availability?date=${date}`, { pollMs: 10000 });
  const prefillState = useApi<{ member: { id: string; name: string; memberCode: string }; status: { tier: string; status: string } }>(
    prefillMemberId ? `/api/members/${prefillMemberId}` : null,
  );
  const prefill: PickedPlayer | null = useMemo(() => {
    const m = prefillState.data;
    if (!m) return null;
    return { key: `m:${m.member.id}`, name: m.member.name, detail: `${m.member.memberCode} · ${m.status.status === "ACTIVE" ? m.status.tier : "walk-in rates"}`, input: { memberId: m.member.id } };
  }, [prefillState.data]);
  const [target, setTarget] = useState<NewBookingTarget | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [maint, setMaint] = useState<{ court: string; slot: Slot } | null>(null);
  const reload = () => void state.reload();

  const onCell = (court: CourtRow, s: Slot, day: string) => {
    if (s.state === "FREE") {
      if (s.bookable && perms.book) setTarget({ courtId: court.courtId, courtName: court.name, maxPlayers: court.maxPlayers, date: day, time: s.time });
      return;
    }
    if (s.state === "SOCIAL") router.push("/app/courts/social");
    else if (s.state === "BOOKED" && s.bookingId) setDetailId(s.bookingId);
    else if (s.state === "MAINTENANCE") setMaint({ court: court.name, slot: s });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Input type="date" className="w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
        <Button variant="outline" size="icon" aria-label="Next day" onClick={() => setDate(addDays(date, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="outline" onClick={() => setDate(state.data?.today ?? initialDate)}>Today</Button>
        <span className="text-sm font-semibold">{fmtDay(date)}</span>
        <Button variant="ghost" size="sm" onClick={reload} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        <div className="ml-auto flex gap-2">
          {perms.maintenance && state.data ? (
            <MaintenanceDialog courts={state.data.dates[0]?.courts ?? []} date={date} open={state.data.open} close={state.data.close} onDone={reload} />
          ) : null}
          {perms.maintenance && state.data ? (
            <CloseCourtsDialog courts={state.data.dates[0]?.courts ?? []} date={date} open={state.data.open} close={state.data.close} onDone={reload} />
          ) : null}
          <Button asChild variant="outline"><Link href="/app/courts/social">Social play</Link></Button>
        </div>
      </div>
      {prefill ? (
        <div className="rounded-md border border-junior/30 bg-junior/10 p-2 text-sm">
          Booking for <strong>{prefill.name}</strong> — click a free slot; they are added as the first player.
        </div>
      ) : null}
      <Legend />
      <Card className="overflow-hidden">
        <DataState state={state}>
          {(a) => {
            const day = a.dates[0];
            const times = day.courts[0]?.slots.map((s) => s.time) ?? [];
            return (
              <div className="overflow-x-auto" data-testid="court-grid">
                <table className="w-full border-separate border-spacing-0.5 text-xs">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left">Court</th>
                      {times.map((t) => (
                        <th key={t} className="min-w-11 px-0.5 py-1 text-left font-medium text-muted-foreground">
                          {t.endsWith(":00") ? t : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {day.courts.map((c) => (
                      <tr key={c.courtId}>
                        <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-2 py-1 text-left">
                          <span className="block text-sm font-semibold">{c.name}</span>
                          <span className="text-[11px] font-normal text-muted-foreground">{c.sport.toLowerCase()}</span>
                          {!c.active ? <Badge tone="red" className="ml-1">inactive</Badge> : null}
                        </th>
                        {spans(c.slots).map(({ slot, span }) => (
                          <td key={slot.time} colSpan={span} className="p-0">
                            <button
                              type="button"
                              className={cn("h-14 w-full rounded px-1 text-left text-[11px] leading-tight", cellClass(slot), slot.past && slot.state !== "FREE" && "opacity-60")}
                              onClick={() => onCell(c, slot, day.date)}
                              disabled={slot.state === "FREE" && (!slot.bookable || !perms.book)}
                              title={slot.state === "FREE" ? (slot.bookable ? `Book ${c.name} at ${slot.time}` : slot.past ? "In the past" : "A 60-minute session can't start here") : `${slot.label} ${slot.range ?? ""}`}
                              data-testid={`cell-${c.name}-${slot.time}`}
                            >
                              {slot.state !== "FREE" ? (
                                <>
                                  <span className="font-semibold">{slot.label}</span>
                                  <span className="block opacity-75">{slot.range}{slot.bookingCode ? ` · ${slot.bookingCode}` : ""}</span>
                                </>
                              ) : slot.bookable ? (
                                <span className="text-success-text opacity-0 hover:opacity-100">+ {slot.time}</span>
                              ) : null}
                            </button>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="p-2 text-[11px] text-muted-foreground">Auto-refreshes every 10 seconds. Sessions are 60 minutes; a new start every 30 minutes.</p>
              </div>
            );
          }}
        </DataState>
      </Card>
      {target ? <BookingDialog key={`${target.courtId}-${target.date}-${target.time}`} target={target} prefill={prefill} onClose={() => setTarget(null)} onBooked={reload} /> : null}
      {detailId ? <BookingDetailDialog bookingId={detailId} onClose={() => setDetailId(null)} onChanged={reload} canManage={perms.book} canCheckin={perms.checkin} canMessage={perms.message} /> : null}
      {maint ? (
        <Dialog open onOpenChange={(o) => { if (!o) setMaint(null); }}>
          <DialogContent title={`${maint.court} — maintenance`} description={`${maint.slot.label} · ${maint.slot.range ?? ""}`}>
            {perms.maintenance && maint.slot.reservationId ? (
              <ConfirmButton
                trigger="Remove block"
                title="Remove this maintenance block?"
                description="The court becomes bookable again for this time."
                confirmLabel="Remove block"
                onConfirm={async () => {
                  await api(`/api/maintenance/${maint.slot.reservationId}`, { body: {} });
                  setMaint(null);
                  reload();
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Only managers can change maintenance blocks.</p>
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
