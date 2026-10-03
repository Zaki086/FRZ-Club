"use client";
import Link from "next/link";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDate, fmtDateTime } from "@/lib/time";

type Exp = { membershipId: string; memberId: string; memberCode: string; name: string; phone: string; plan: string; endDate: string; expired: boolean };
type Due = { billId: string; customer: string; memberId: string | null; sourceType: string; due: number; createdAt: string; description: string };

export function ExpiringAndDues() {
  const exp = useApi<Exp[]>("/api/members/expiring");
  const dues = useApi<Due[]>("/api/members/dues");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Expiring in 7 days</CardTitle></CardHeader>
        <CardContent>
          <DataState state={exp} isEmpty={(d) => d.length === 0} empty={{ title: "No memberships expiring soon" }}>
            {(rows) => (
              <Table>
                <THead><TR><TH>Member</TH><TH>Plan</TH><TH>Ends</TH><TH>Phone</TH></TR></THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.membershipId}>
                      <TD><Link className="font-medium text-primary hover:underline" href={`/app/members/${r.memberId}`}>{r.name}</Link> <span className="font-mono text-xs text-muted-foreground">{r.memberCode}</span></TD>
                      <TD><TierBadge tier={r.plan} /></TD>
                      <TD>{r.expired ? <Badge tone="red">EXPIRED {fmtDate(r.endDate)}</Badge> : fmtDate(r.endDate)}</TD>
                      <TD><a className="text-primary" href={`tel:${r.phone}`}>{r.phone}</a></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </DataState>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Customer dues</CardTitle></CardHeader>
        <CardContent>
          <DataState state={dues} isEmpty={(d) => d.length === 0} empty={{ title: "Nobody owes anything" }}>
            {(rows) => (
              <Table>
                <THead><TR><TH>Customer</TH><TH>For</TH><TH>Since</TH><TH className="text-right">Due</TH></TR></THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.billId}>
                      <TD>{r.memberId ? <Link className="text-primary hover:underline" href={`/app/members/${r.memberId}`}>{r.customer}</Link> : r.customer}</TD>
                      <TD className="text-sm">{r.description}</TD>
                      <TD className="text-sm">{fmtDateTime(r.createdAt)}</TD>
                      <TD className="text-right"><Money paise={r.due} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
