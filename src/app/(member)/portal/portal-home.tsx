"use client";
import Link from "next/link";
import { CalendarPlus, AlertTriangle, Beer } from "lucide-react";
import { useApi } from "@/components/api";
import { useNow } from "./_components/use-now";
import { RefundReadyBanner } from "./_components/refund-banner";
import { DataState, Empty } from "@/components/states";
import { MemberCard } from "@/components/member-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDateTime, fmtRange } from "@/lib/time";
import { formatINR } from "@/lib/money";

type Data = {
  member: { name: string };
  status: { status: string; endDate: string | null };
  bookings: Array<{ id: string; code: string; court: string; startAt: string; endAt: string; status: string; fee: number }>;
  dues: Array<{ id: string; due: number; description: string }>;
  openTab: { code: string; due: number } | null;
  totals: { discountsSaved: number; dueTotal: number };
};

export function PortalHome({ memberId }: { memberId: string }) {
  const state = useApi<Data>(`/api/members/${memberId}`);
  const nowMs = useNow();
  return (
    <DataState state={state}>
      {(d) => {
        const upcoming = d.bookings.filter((b) => b.status === "CONFIRMED" && new Date(b.endAt).getTime() > nowMs).sort((a, b) => a.startAt.localeCompare(b.startAt));
        return (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-bold">Hi {d.member.name.split(" ")[0]}</h1>
            <MemberCard memberId={memberId} />
            <RefundReadyBanner />
            {d.status.status !== "ACTIVE" ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> Your membership is not active, so walk-in prices apply.{" "}
                <Link className="font-semibold underline" href="/portal/membership">Renew now</Link>
              </div>
            ) : null}
            {d.openTab ? (
              <div className="flex items-center gap-2 rounded-md border border-warning/50 bg-warning/15 p-3 text-sm">
                <Beer className="h-4 w-4" /> Open bar tab {d.openTab.code}: {formatINR(d.openTab.due)}. <Link className="underline" href="/portal/tab">View</Link>
              </div>
            ) : null}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Upcoming bookings</CardTitle>
                <Button asChild size="sm"><Link href="/portal/book"><CalendarPlus className="h-4 w-4" /> Book</Link></Button>
              </CardHeader>
              <CardContent>
                {upcoming.length === 0 ? (
                  <Empty title="No upcoming bookings" hint="Book a court or join Friday social play." />
                ) : (
                  <div className="divide-y">
                    {upcoming.map((b) => (
                      <div key={b.id} className="flex items-center justify-between py-2 text-sm">
                        <div>
                          <p className="font-medium">{b.court} · {fmtDateTime(b.startAt).split(",")[0]} {fmtRange(b.startAt, b.endAt)}</p>
                          <p className="font-mono text-xs text-muted-foreground">{b.code}</p>
                        </div>
                        <div className="text-right"><Money paise={b.fee} /><br /><StatusBadge status={b.status} /></div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Discounts saved</p><p className="text-2xl font-bold"><Money paise={d.totals.discountsSaved} /></p></CardContent></Card>
              <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Dues</p><p className="text-2xl font-bold"><Money paise={d.totals.dueTotal} /></p>
                {d.dues.length ? <Link className="text-sm text-primary underline" href="/portal/bookings">Pay dues</Link> : null}</CardContent></Card>
            </div>
          </div>
        );
      }}
    </DataState>
  );
}
