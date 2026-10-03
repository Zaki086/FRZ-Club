"use client";
import { useApi } from "@/components/api";
import { DataState, Empty } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MemberCard } from "@/components/member-card";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { fmtRange, fmtDateTime } from "@/lib/time";

type Junior = { id: string; name: string; memberCode: string; status: MemberStatus; bookings: Array<{ id: string; code: string; court: string; startAt: string; endAt: string }> };

export function FamilyView() {
  const state = useApi<Junior[]>("/api/portal/family");
  return (
    <DataState state={state}>
      {(list) =>
        list.length === 0 ? (
          <Empty title="No one listed under you" hint="When the desk signs up a Junior with your mobile number as the guardian, they appear here." />
        ) : (
          <div className="flex flex-col gap-4" data-testid="family">
            {list.map((j) => (
              <Card key={j.id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">{j.name} <span className="font-mono text-xs text-muted-foreground">{j.memberCode}</span> <MemberStatusBadge status={j.status} /></CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <MemberCard memberId={j.id} />
                  <div>
                    <p className="font-medium">Upcoming bookings</p>
                    {j.bookings.length === 0 ? (
                      <p className="text-muted-foreground">None in the next two weeks.</p>
                    ) : (
                      j.bookings.map((b) => (
                        <p key={b.id}>{fmtDateTime(b.startAt).split(",")[0]} · {fmtRange(b.startAt, b.endAt)} · {b.court} <span className="font-mono text-xs text-muted-foreground">{b.code}</span></p>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      }
    </DataState>
  );
}
