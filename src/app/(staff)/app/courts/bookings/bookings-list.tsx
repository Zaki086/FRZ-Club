"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { addDays, fmtDay, fmtRange } from "@/lib/time";
import { BookingDetailDialog } from "../_components/booking-detail";
import type { BookingView } from "../_components/types";

export function BookingsList({ initialDate, perms }: { initialDate: string; perms: { book: boolean; checkin: boolean } }) {
  const [date, setDate] = useState(initialDate);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const state = useApi<BookingView[]>(`/api/bookings?date=${date}&status=${status}&q=${encodeURIComponent(q.trim())}`, { pollMs: 15000 });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Input type="date" className="w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
        <Button variant="outline" size="icon" aria-label="Next day" onClick={() => setDate(addDays(date, 1))}><ChevronRight className="h-4 w-4" /></Button>
        <span className="text-sm font-semibold">{fmtDay(date)}</span>
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="COMPLETED">Completed</option>
          <option value="NO_SHOW">No-show</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        <Input className="max-w-xs" placeholder="Search code or player" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No bookings for this day", hint: "Book from the command centre." }}>
          {(rows) => (
            <Table>
              <THead>
                <TR><TH>Code</TH><TH>Court</TH><TH>Time</TH><TH>Players</TH><TH>Channel</TH><TH className="text-right">Total</TH><TH className="text-right">Due</TH><TH>Status</TH></TR>
              </THead>
              <TBody>
                {rows.map((b) => (
                  <TR key={b.id} className="cursor-pointer" onClick={() => setOpen(b.id)}>
                    <TD className="font-mono text-xs">{b.code}</TD>
                    <TD>{b.court}</TD>
                    <TD className="whitespace-nowrap">{fmtRange(b.startAt, b.endAt)}</TD>
                    <TD className="text-sm">{b.players.map((p) => p.name).join(", ")}</TD>
                    <TD className="text-xs">{b.channel.replace("_", " ")}</TD>
                    <TD className="text-right"><Money paise={b.total} /></TD>
                    <TD className="text-right">{b.due > 0 ? <Money paise={b.due} className="font-semibold text-amber-700" /> : "—"}</TD>
                    <TD><StatusBadge status={b.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
      {open ? <BookingDetailDialog bookingId={open} onClose={() => setOpen(null)} onChanged={() => void state.reload()} canManage={perms.book} canCheckin={perms.checkin} /> : null}
    </div>
  );
}
