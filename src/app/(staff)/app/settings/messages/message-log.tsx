"use client";
import { useState } from "react";
import { useApi } from "@/components/api";
import { DataState, Empty } from "@/components/states";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/time";

type Row = { id: string; channel: string; to: string; subject: string; body: string; status: string; error: string | null; entity: string | null; at: string; actorName: string | null };

export function MessageLogView() {
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams();
  if (channel) params.set("channel", channel);
  if (status) params.set("status", status);
  if (q.trim().length >= 2) params.set("q", q.trim());
  const state = useApi<Row[]>(`/api/messages?${params.toString()}`);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Select className="w-36" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="">All channels</option>
          <option value="EMAIL">Email</option>
          <option value="WHATSAPP">WhatsApp</option>
        </Select>
        <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="SENT">Sent</option>
          <option value="FAILED">Failed</option>
          <option value="OPENED">Opened (WhatsApp)</option>
        </Select>
        <Input className="w-56" placeholder="Search recipient or text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      <DataState state={state}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty title="No messages yet" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>When</TH><TH>Channel</TH><TH>To</TH><TH>Message</TH><TH>Status</TH><TH>By</TH></TR></THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</TD>
                      <TD>{r.channel === "WHATSAPP" ? "WhatsApp" : "Email"}</TD>
                      <TD className="font-mono text-xs">{r.to}</TD>
                      <TD className="max-w-md text-xs">{r.subject ? <strong className="block">{r.subject}</strong> : null}<span className="line-clamp-2">{r.body}</span>{r.error ? <span className="block text-red-700">{r.error}</span> : null}</TD>
                      <TD><Badge tone={r.status === "SENT" ? "green" : r.status === "FAILED" ? "red" : "neutral"}>{r.status.toLowerCase()}</Badge></TD>
                      <TD className="text-xs">{r.actorName ?? "system"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )
        }
      </DataState>
    </div>
  );
}
