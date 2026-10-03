"use client";
// v4 §1.2 Check-in Risk: each arrival with its problems and the one-click fix (the screen that already does it).
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtRange, istDate, fmtDay } from "@/lib/time";

type Kind = "UNPAID" | "MEMBERSHIP_EXPIRED" | "MEMBERSHIP_EXPIRING" | "DUES" | "OPEN_TAB" | "CLUB_CANCELLED_PENDING";
type Risk = { kind: Kind; who: string; problem: string; amountPaise: number | null; fix: { label: string; href: string } };
type Arrival = { key: string; type: "BOOKING" | "SOCIAL"; code: string | null; title: string; startAt: string; endAt: string; soon: boolean; players: string[]; risks: Risk[] };
type Data = { generatedAt: string; until: string; arrivals: Arrival[]; counts: Record<Kind, number>; total: number; soon: number };

const KIND: Record<Kind, { label: string; tone: "red" | "amber" | "blue" | "neutral" }> = {
  UNPAID: { label: "Unpaid", tone: "red" },
  MEMBERSHIP_EXPIRED: { label: "Membership expired", tone: "red" },
  MEMBERSHIP_EXPIRING: { label: "Expiring ≤ 7 days", tone: "amber" },
  DUES: { label: "Dues", tone: "amber" },
  OPEN_TAB: { label: "Open bar tab", tone: "amber" },
  CLUB_CANCELLED_PENDING: { label: "Club cancellation pending", tone: "blue" },
};

export function RiskList() {
  const state = useApi<Data>("/api/desk/risk", { pollMs: 60_000 });
  const [scope, setScope] = useState<"soon" | "today">("soon");
  const [kind, setKind] = useState<Kind | null>(null);
  return (
    <DataState state={state}>
      {(d) => {
        const rows = d.arrivals.filter((a) => (scope === "today" || a.soon) && (!kind || a.risks.some((r) => r.kind === kind)));
        return (
          <div className="flex flex-col gap-3" data-testid="checkin-risk">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-full border p-0.5" role="group" aria-label="When">
                <Button size="sm" variant={scope === "soon" ? "default" : "ghost"} onClick={() => setScope("soon")} aria-pressed={scope === "soon"}>
                  Next 2 hours ({d.soon})
                </Button>
                <Button size="sm" variant={scope === "today" ? "default" : "ghost"} onClick={() => setScope("today")} aria-pressed={scope === "today"}>
                  All of today ({d.total})
                </Button>
              </div>
              {(Object.keys(KIND) as Kind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(kind === k ? null : k)}
                  aria-pressed={kind === k}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${kind === k ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  data-testid={`risk-count-${k}`}
                >
                  {KIND[k].label} · {d.counts[k]}
                </button>
              ))}
            </div>
            {rows.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  {d.total === 0 ? "No problems for anyone arriving today or in the next 2 hours." : "Nothing matches — try “All of today” or remove the problem filter."}
                </CardContent>
              </Card>
            ) : (
              rows.map((a) => (
                <Card key={a.key} data-testid="risk-arrival">
                  <CardContent className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold">
                        {istDate(new Date(a.startAt)) !== istDate(new Date(d.generatedAt)) ? `${fmtDay(istDate(new Date(a.startAt)))} · ` : ""}
                        {fmtRange(a.startAt, a.endAt)} · {a.title}
                      </p>
                      <p className="text-sm text-muted-foreground">{a.players.join(", ")}</p>
                    </div>
                    <ul className="divide-y rounded-xl border">
                      {a.risks.map((r, i) => (
                        <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge>
                            <span className="font-medium">{r.who}</span>
                            <span className="text-muted-foreground">{r.problem}</span>
                          </span>
                          <Button asChild size="sm" variant={r.kind === "UNPAID" ? "default" : "outline"}>
                            <Link href={r.fix.href}>{r.fix.label}</Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        );
      }}
    </DataState>
  );
}
