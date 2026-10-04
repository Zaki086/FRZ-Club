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
import { SendMessageButton } from "@/components/message-composer";
import { BulkSendButton } from "@/components/message-composer-bulk";
import { BULK_MAX } from "@/server/services/messages/contract";

type Kind = "UNPAID" | "MEMBERSHIP_EXPIRED" | "MEMBERSHIP_EXPIRING" | "DUES" | "OPEN_TAB" | "CLUB_CANCELLED_PENDING";
// v5: `memberId` — whose problem it is (the message goes to them); null for a booking's unpaid bill or a guest.
type Risk = { kind: Kind; who: string; problem: string; amountPaise: number | null; fix: { label: string; href: string }; memberId: string | null };
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

/** v5 §3.3: who a row's "Send message" goes to — the member, or the booking (its unpaid bill) when it isn't one member's. */
function messageTarget(a: Arrival, r: Risk): { context: "MEMBER" | "BOOKING"; recordId: string } | null {
  if (r.memberId) return { context: "MEMBER", recordId: r.memberId };
  if (a.type === "BOOKING" && a.key.startsWith("booking:")) return { context: "BOOKING", recordId: a.key.slice("booking:".length) };
  return null;
}

export function RiskList({ messaging }: { messaging?: { compose: boolean; bulk: boolean; editText: boolean } }) {
  const state = useApi<Data>("/api/desk/risk", { pollMs: 60_000 });
  const [scope, setScope] = useState<"soon" | "today">("soon");
  const [kind, setKind] = useState<Kind | null>(null);
  // v5 §3.4: bulk selection — members picked by checkbox, or everyone in the current view ("all N matching").
  const [picked, setPicked] = useState<string[]>([]);
  const [allFilter, setAllFilter] = useState<string | null>(null);
  const filter = `scope=${scope}${kind ? `&kind=${kind}` : ""}`;
  const allMatching = allFilter === filter;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= BULK_MAX ? p : [...p, id]));
  const clear = () => { setPicked([]); setAllFilter(null); };
  return (
    <DataState state={state}>
      {(d) => {
        const rows = d.arrivals.filter((a) => (scope === "today" || a.soon) && (!kind || a.risks.some((r) => r.kind === kind)));
        const inView = [...new Set(rows.flatMap((a) => a.risks.filter((r) => !kind || r.kind === kind).map((r) => r.memberId)).filter((x): x is string => !!x))];
        const count = allMatching ? inView.length : picked.length;
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
            {messaging?.bulk && count ? (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/40 bg-primary/5 px-3 py-2 text-sm" data-testid="selection-bar">
                <span className="font-semibold" data-testid="selection-count">{allMatching ? `All ${count} members in this view` : `${count} selected`}</span>
                {!allMatching && inView.length > picked.length && inView.length <= BULK_MAX ? (
                  <button type="button" className="text-xs font-semibold text-primary underline" onClick={() => setAllFilter(filter)} data-testid="select-all-matching">Select all {inView.length} members in this view</button>
                ) : null}
                <button type="button" className="text-xs font-semibold text-muted-foreground underline" onClick={clear}>Clear selection</button>
                <span className="ml-auto">
                  <BulkSendButton list="checkin-risk" target={allMatching ? { filter, count } : { ids: picked, count }} onDone={() => { clear(); void state.reload(); }} canEditText={messaging.editText} />
                </span>
              </div>
            ) : null}
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
                      {a.risks.map((r, i) => {
                        const target = messaging?.compose ? messageTarget(a, r) : null;
                        return (
                        <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex flex-wrap items-center gap-2">
                            {messaging?.bulk && r.memberId ? (
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={allMatching ? inView.includes(r.memberId) : picked.includes(r.memberId)}
                                disabled={allMatching}
                                onChange={() => toggle(r.memberId!)}
                                aria-label={`Select ${r.who}`}
                                data-testid="row-select"
                              />
                            ) : null}
                            <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge>
                            <span className="font-medium">{r.who}</span>
                            <span className="text-muted-foreground">{r.problem}</span>
                          </span>
                          <span className="flex flex-wrap items-center gap-1">
                            {target ? <SendMessageButton context={target.context} recordId={target.recordId} /> : null}
                            <Button asChild size="sm" variant={r.kind === "UNPAID" ? "default" : "outline"}>
                              <Link href={r.fix.href}>{r.fix.label}</Link>
                            </Button>
                          </span>
                        </li>
                        );
                      })}
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
