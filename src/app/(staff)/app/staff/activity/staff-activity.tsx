"use client";
import { useState } from "react";
import { useApi } from "@/components/api";
import { DataState, Empty } from "@/components/states";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/components/ui/cn";
import { fmtDateTime } from "@/lib/time";

type Data = {
  date: string;
  staff: Array<{ id: string; name: string; role: string; actions: number }>;
  rows: Array<{ id: string; at: string; action: string; entity: string; entityId: string; reason: string | null; who: string }>;
};

export function StaffActivity() {
  const [date, setDate] = useState("");
  const [userId, setUserId] = useState("");
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (userId) qs.set("userId", userId);
  const state = useApi<Data>(`/api/staff/activity?${qs.toString()}`);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <Input type="date" className="w-44" value={date || d.date} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
          <div className="flex flex-wrap gap-1">
            <button className={cn("rounded-full border px-3 py-1 text-sm", !userId && "border-primary bg-primary text-white")} onClick={() => setUserId("")}>Everyone</button>
            {d.staff.map((s) => (
              <button key={s.id} className={cn("rounded-full border px-3 py-1 text-sm", userId === s.id && "border-primary bg-primary text-white")} onClick={() => setUserId(s.id)}>
                {s.name} <span className="text-xs opacity-70">({s.actions})</span>
              </button>
            ))}
          </div>
          {d.rows.length === 0 ? (
            <Empty title="No activity that day" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>When</TH><TH>Who</TH><TH>Action</TH><TH>On</TH><TH>Reason</TH></TR></THead>
                <TBody>
                  {d.rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</TD>
                      <TD>{r.who}</TD>
                      <TD className="font-mono text-xs">{r.action}</TD>
                      <TD className="text-xs">{r.entity.replace(/_/g, " ")}</TD>
                      <TD className="text-xs">{r.reason ?? ""}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </DataState>
  );
}
