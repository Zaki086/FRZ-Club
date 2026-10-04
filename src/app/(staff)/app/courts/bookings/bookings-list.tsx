"use client";
// v3 §3, §7.1: bookings with the standard FilterBar (default: today, with a day stepper), a summary strip and the
// next action per row. A row opens the booking detail in place (no navigation).
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtRange } from "@/lib/time";
import { FilteredList } from "@/components/list/filtered-list";
import { BookingDetailDialog } from "../_components/booking-detail";

type Row = {
  id: string; code: string; start_at: string; end_at: string; court: string; sport: string; status: string; channel: string;
  total: number; due: number; payment: string; who: string; players: string | null; checked_in: number; n_players: number;
};

const PAY: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  PAID: { label: "Paid", tone: "green" }, PARTIAL: { label: "Part-paid", tone: "amber" }, UNPAID: { label: "Unpaid", tone: "red" }, FREE: { label: "Nothing to pay", tone: "neutral" },
};

function NextAction({ r, now }: { r: Row; now: number }) {
  if (r.status !== "CONFIRMED") return null;
  if (r.due > 0) return <span className="text-sm font-semibold text-primary">Collect <Money paise={r.due} /></span>;
  const start = new Date(r.start_at).getTime();
  const end = new Date(r.end_at).getTime();
  if (now >= start - 30 * 60_000 && now < end && r.checked_in < r.n_players) return <span className="text-sm font-semibold text-primary">Check in ({r.checked_in}/{r.n_players})</span>;
  return null;
}

export function BookingsList({ perms }: { initialDate?: string; perms: { book: boolean; checkin: boolean; message?: boolean } }) {
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  return (
    <>
      <FilteredList<Row>
        list="bookings"
        searchPlaceholder="Booking code, player or court"
        dayStepper
        pollMs={15000}
        onRowClick={(r) => setOpen(r.id)}
        columns={[
          { key: "time", header: "Time", className: "whitespace-nowrap", cell: (r) => <span className="font-semibold">{fmtRange(r.start_at, r.end_at)}</span> },
          { key: "court", header: "Court", cell: (r) => r.court },
          { key: "players", header: "Players", cell: (r) => <span className="text-sm">{r.players ?? "—"} <span className="font-mono text-xs text-muted-foreground">{r.code}</span></span> },
          { key: "pay", header: "Payment", cell: (r) => <Badge tone={PAY[r.payment]?.tone ?? "neutral"}>{PAY[r.payment]?.label ?? r.payment}</Badge> },
          { key: "total", header: "Total", className: "text-right", cell: (r) => <Money paise={r.total} /> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "next", header: "Next", cell: (r) => <NextAction r={r} now={now} /> },
        ]}
        empty={{ title: "No bookings match", hint: "Change the day or remove a filter; new bookings are made from the command centre." }}
      />
      {open ? <BookingDetailDialog bookingId={open} onClose={() => setOpen(null)} onChanged={() => undefined} canManage={perms.book} canCheckin={perms.checkin} canMessage={perms.message} /> : null}
    </>
  );
}
