"use client";
// Completion pass §7 (front desk): the "Today" panel above the search.
import Link from "next/link";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { fmtRange } from "@/lib/time";

type Today = {
  arriving: Array<{ id: string; code: string; court: string; startAt: string; due: number; players: string[]; checkedIn: number; total: number }>;
  dues: { count: number; total: number };
  bookingsToday: number;
  checkinsToday: number;
  pendingRefunds: number;
  expiringThisWeek: number;
  /** null when this person can't open the list (no tile then). */
  messagesToSend: number | null;
  overdueFollowUps: number | null;
  drawer: { area: string; cashExpected: number } | null;
};

export function DeskToday() {
  const state = useApi<Today>("/api/desk/today", { pollMs: 30_000 });
  return (
    <DataState state={state}>
      {(t) => (
        <div className="mb-4 flex flex-col gap-3" data-testid="desk-today">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Link href="/app/courts/bookings" className="rounded-md border p-2 hover:bg-muted">Bookings today<br /><span className="text-lg font-bold">{t.bookingsToday}</span></Link>
            <Link href="/app/desk/visits" className="rounded-md border p-2 hover:bg-muted">Checked in<br /><span className="text-lg font-bold">{t.checkinsToday}</span></Link>
            <div className={`rounded-md border p-2 ${t.dues.count ? "border-warning/50 bg-warning/15" : ""}`}>To collect<br /><Money paise={t.dues.total} className="text-lg font-bold" /> <span className="text-xs">({t.dues.count})</span></div>
            <Link href="/app/refunds" className={`rounded-md border p-2 hover:bg-muted ${t.pendingRefunds ? "border-warning/50 bg-warning/15" : ""}`}>Refunds to pay<br /><span className="text-lg font-bold">{t.pendingRefunds}</span></Link>
            <Link href="/app/desk/expiring" className="rounded-md border p-2 hover:bg-muted">Expiring in 7 days<br /><span className="text-lg font-bold">{t.expiringThisWeek}</span></Link>
            {t.messagesToSend !== null ? (
              <Link href="/app/messages?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED" className={`rounded-md border p-2 hover:bg-muted ${t.messagesToSend ? "border-warning/50 bg-warning/15" : ""}`} data-testid="desk-messages-to-send">
                Messages to send<br /><span className="text-lg font-bold">{t.messagesToSend}</span>
              </Link>
            ) : null}
            {t.overdueFollowUps !== null ? (
              <Link href="/app/crm" className={`rounded-md border p-2 hover:bg-muted ${t.overdueFollowUps ? "border-warning/50 bg-warning/15" : ""}`} data-testid="desk-overdue-follow-ups">
                My overdue follow-ups<br /><span className="text-lg font-bold">{t.overdueFollowUps}</span>
              </Link>
            ) : null}
            <Link href="/app/drawer" className={`rounded-md border p-2 hover:bg-muted ${t.drawer ? "" : "border-destructive/40 bg-destructive/10"}`}>
              My drawer<br />{t.drawer ? <Money paise={t.drawer.cashExpected} className="text-lg font-bold" /> : <span className="font-semibold text-destructive">Not open</span>}
            </Link>
          </div>
          <Card>
            <CardHeader><CardTitle>Arriving in the next 3 hours</CardTitle></CardHeader>
            <CardContent>
              {t.arriving.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody due in the next 3 hours.</p>
              ) : (
                <div className="divide-y text-sm">
                  {t.arriving.map((b) => (
                    <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{fmtRange(b.startAt, new Date(new Date(b.startAt).getTime() + 3_600_000))}</span> · {b.court} · {b.players.join(", ")}
                        <span className="ml-1 font-mono text-xs text-muted-foreground">{b.code}</span>
                      </span>
                      <span className="flex items-center gap-2 text-xs">
                        <span>{b.checkedIn}/{b.total} in</span>
                        {b.due > 0 ? <span className="font-semibold text-warning-text"><Money paise={b.due} /> due</span> : <span className="text-success-text">paid</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </DataState>
  );
}
