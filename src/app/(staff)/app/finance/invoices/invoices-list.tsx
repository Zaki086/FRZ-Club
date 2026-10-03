"use client";
import Link from "next/link";
import { useState } from "react";
import { FilePlus } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { dateOnly } from "../_components/fmt";

type Row = { id: string; number: string | null; kind: string; customer: string; issueDate: string | null; dueDate: string | null; total: number; due: number; status: string; overdue: boolean };

export function InvoicesList({ clientId, initialStatus }: { clientId: string; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (clientId) q.set("clientId", clientId);
  const state = useApi<Row[]>(`/api/invoices?${q.toString()}`);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-52" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="ISSUED">Issued</option>
          <option value="PARTIALLY_PAID">Partially paid</option>
          <option value="PAID">Paid</option>
          <option value="OVERDUE">Overdue</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        {clientId ? (
          <Link href="/app/finance/invoices" className="text-sm text-primary underline">
            Showing one client — show all
          </Link>
        ) : null}
        <Button asChild className="ml-auto">
          <Link href={`/app/finance/invoices/new${clientId ? `?clientId=${clientId}` : ""}`}>
            <FilePlus className="h-4 w-4" /> New invoice
          </Link>
        </Button>
      </div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No invoices", hint: "Create a draft for a business client or a member." }}>
          {(rows) => (
            <Table>
              <THead>
                <TR>
                  <TH>Number</TH>
                  <TH>Customer</TH>
                  <TH>Type</TH>
                  <TH>Issued</TH>
                  <TH>Due</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Balance</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link className="font-mono text-xs font-semibold text-primary hover:underline" href={`/app/finance/invoices/${r.id}`}>
                        {r.number ?? "Draft"}
                      </Link>
                    </TD>
                    <TD>{r.customer}</TD>
                    <TD className="text-xs">{r.kind.toLowerCase()}</TD>
                    <TD className="text-sm">{dateOnly(r.issueDate)}</TD>
                    <TD className="text-sm">{dateOnly(r.dueDate)}</TD>
                    <TD className="text-right"><Money paise={r.total} /></TD>
                    <TD className="text-right"><Money paise={r.due} /></TD>
                    <TD className="flex gap-1">
                      <StatusBadge status={r.status} />
                      {r.overdue ? <StatusBadge status="OVERDUE" /> : null}
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
