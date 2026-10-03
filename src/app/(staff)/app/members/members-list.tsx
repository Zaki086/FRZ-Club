"use client";
import Link from "next/link";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";

type Row = { id: string; memberCode: string; name: string; phone: string; status: MemberStatus };

export function MembersList({ canCreate }: { canCreate: boolean }) {
  const [q, setQ] = useState("");
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");
  const url = q.trim().length >= 2 ? `/api/members?q=${encodeURIComponent(q.trim())}` : `/api/members?tier=${tier}&status=${status}`;
  const state = useApi<Row[]>(url);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-sm" placeholder="Search name, phone or CC-000123" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <Select className="w-36" value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
          <option value="">All tiers</option>
          <option value="GOLD">Gold</option>
          <option value="SILVER">Silver</option>
          <option value="JUNIOR">Junior</option>
          <option value="WALK_IN">No active plan</option>
        </Select>
        <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="ACTIVE">Active</option>
          <option value="EXPIRED">Expired</option>
          <option value="NONE">Never had a plan</option>
        </Select>
        {canCreate ? (
          <Button asChild className="ml-auto">
            <Link href="/app/members/new">
              <UserPlus className="h-4 w-4" /> New member
            </Link>
          </Button>
        ) : null}
      </div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No members found", hint: "Try another name, phone or code." }}>
          {(rows) => (
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH>Phone</TH>
                  <TH>Membership</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((m) => (
                  <TR key={m.id}>
                    <TD className="font-mono text-xs">{m.memberCode}</TD>
                    <TD>
                      <Link className="font-medium text-primary hover:underline" href={`/app/members/${m.id}`}>
                        {m.name}
                      </Link>
                    </TD>
                    <TD>{m.phone}</TD>
                    <TD>
                      <MemberStatusBadge status={m.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
    </div>
  );
}
