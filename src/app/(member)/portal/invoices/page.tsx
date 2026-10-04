"use client";
import Link from "next/link";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { fmtDate } from "@/lib/time";

type Inv = { id: string; number: string | null; issueDate: string | null; total: number; due: number; status: string; overdue: boolean; kind: string };

export default function PortalInvoicesPage() {
  const state = useApi<Inv[]>("/api/invoices");
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Invoices</h1>
      <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No invoices yet" }}>
        {(rows) => (
          <Card className="divide-y">
            {rows.map((i) => (
              <Link key={i.id} href={`/portal/invoices/${i.id}`} className="flex items-center justify-between p-3 text-sm hover:bg-muted">
                <div>
                  <p className="font-medium">{i.number}</p>
                  <p className="text-xs text-muted-foreground">{i.issueDate ? fmtDate(i.issueDate.slice(0, 10)) : ""} · {i.kind.toLowerCase()}</p>
                </div>
                <div className="flex items-center gap-2"><Money paise={i.total} /><StatusBadge status={i.overdue ? "OVERDUE" : i.status} /></div>
              </Link>
            ))}
          </Card>
        )}
      </DataState>
    </div>
  );
}
