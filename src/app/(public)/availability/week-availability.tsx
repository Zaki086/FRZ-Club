"use client";
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { addDays, fmtDay } from "@/lib/time";

type Slot = { time: string; state: "FREE" | "BOOKED" | "SOCIAL" | "MAINTENANCE"; label: string; bookable: boolean; past: boolean };
type Court = { courtId: string; name: string; sport: string; active: boolean; slots: Slot[] };
type Avail = { today: string; dates: Array<{ date: string; courts: Court[] }> };

const CELL: Record<Slot["state"], string> = {
  FREE: "bg-emerald-50 text-emerald-800 border-emerald-200",
  BOOKED: "bg-rose-100 text-rose-800 border-rose-200",
  SOCIAL: "bg-purple-100 text-purple-800 border-purple-200",
  MAINTENANCE: "bg-slate-200 text-slate-700 border-slate-300",
};

function todayStr() {
  // The server's "today" is authoritative; this is only the first request's start date (IST).
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export function WeekAvailability() {
  const [from] = useState(todayStr);
  const state = useApi<Avail>(`/api/availability?date=${from}&days=7`, { pollMs: 30_000 });
  const [idx, setIdx] = useState(0);
  return (
    <DataState state={state}>
      {(a) => {
        const day = a.dates[Math.min(idx, a.dates.length - 1)];
        const trialDays = [a.today, addDays(a.today, 1)];
        return (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {a.dates.map((d, i) => {
                const free = d.courts.reduce((n, c) => n + c.slots.filter((s) => s.bookable).length, 0);
                return (
                  <button
                    key={d.date}
                    onClick={() => setIdx(i)}
                    className={cn("min-w-24 rounded-lg border px-3 py-2 text-left text-sm", i === idx ? "border-primary bg-primary text-white" : "bg-card hover:bg-muted")}
                  >
                    <span className="block font-semibold">{d.date === a.today ? "Today" : fmtDay(d.date)}</span>
                    <span className={cn("text-xs", i === idx ? "text-emerald-100" : "text-muted-foreground")}>{free} free starts</span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {(["FREE", "BOOKED", "SOCIAL", "MAINTENANCE"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1"><span className={cn("inline-block h-3 w-3 rounded border", CELL[s])} />{s === "FREE" ? "Free" : s === "BOOKED" ? "Booked" : s === "SOCIAL" ? "Social play" : "Maintenance"}</span>
              ))}
              {trialDays.includes(day.date) ? <span className="text-muted-foreground">Tap a free start time to book a trial.</span> : null}
            </div>
            <Card>
              <CardContent className="overflow-x-auto p-3">
                <table className="border-separate border-spacing-1 text-xs">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-card pr-2 text-left">Court</th>
                      {day.courts[0]?.slots.map((s) => <th key={s.time} className="px-1 font-medium text-muted-foreground">{s.time}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {day.courts.map((c) => (
                      <tr key={c.courtId}>
                        <td className="sticky left-0 z-10 whitespace-nowrap bg-card pr-2 font-semibold">{c.name}</td>
                        {c.slots.map((s) => {
                          const canTrial = s.bookable && trialDays.includes(day.date);
                          const label = s.past && s.state === "FREE" ? "—" : s.state === "FREE" ? "Free" : s.label;
                          const cls = cn("block min-w-14 rounded border px-1 py-1.5 text-center", CELL[s.state], s.past && "opacity-40");
                          return (
                            <td key={s.time}>
                              {canTrial ? (
                                <Link href={`/trial?courtId=${c.courtId}&date=${day.date}&time=${s.time}`} className={cn(cls, "hover:ring-2 hover:ring-primary")} title={`Book a trial at ${s.time}`}>{label}</Link>
                              ) : (
                                <span className={cls} title={s.bookable ? "Free to book" : label}>{label}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">Updates automatically every 30 seconds. A start time is free only when the whole hour is free.</p>
          </div>
        );
      }}
    </DataState>
  );
}
