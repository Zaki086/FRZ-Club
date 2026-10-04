"use client";
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { istTime } from "@/lib/time";
import { toRejection, type Rejection } from "../_components/err";

type Ready = { id: string; name: string; qty: number; note: string | null; readyAt: string | null; table: number | null; tabCode: string; payer: string };

export function ReadyQueue() {
  const state = useApi<Ready[]>("/api/bar/ready", { pollMs: 4000 });
  const [error, setError] = useState<Rejection>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <RejectionBanner error={error} />
      <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "Nothing waiting" }}>
        {(rows) => (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <Card key={r.id} className="flex items-center justify-between gap-3 p-4" data-testid="ready-item">
                <div className="min-w-0">
                  <p className="text-2xl font-black">{r.table ? `Table ${r.table}` : "Counter"}</p>
                  <p className="font-semibold">{r.payer} <span className="font-mono text-xs text-muted-foreground">{r.tabCode}</span></p>
                  <p className="text-lg">{r.qty} × {r.name}</p>
                  {r.note ? <p className="text-sm text-amber-700">{r.note}</p> : null}
                  {r.readyAt ? <p className="text-xs text-muted-foreground">Ready since {istTime(new Date(r.readyAt))}</p> : null}
                </div>
                <Button
                  size="xl"
                  disabled={busy === r.id}
                  onClick={async () => {
                    setBusy(r.id);
                    setError(null);
                    try {
                      await api(`/api/bar/lines/${r.id}/status`, { body: { status: "SERVED" } });
                      await state.reload();
                    } catch (e) {
                      setError(toRejection(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Served
                </Button>
              </Card>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
