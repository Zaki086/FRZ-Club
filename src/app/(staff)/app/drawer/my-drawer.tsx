"use client";
// Cash drawer (completion pass 8.4): open with a float → every cash/card/UPI payment you take links to it →
// close with the counted cash. The expected amount and the variance come from the server.
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Money } from "@/components/money";
import { DrawerOpener } from "@/components/tender-fields";
import { DrawerBreakdown, type Collection } from "@/components/drawer-breakdown";
import { fmtDateTime } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";

type Drawer = { open: null | { id: string; area: string; openedAt: string; openingFloat: number; cashIn: number; cashOut: number; cashExpected: number; card: number; upi: number; collections: Collection[]; totalCollected: number } };
type Closed = { cashExpected: number; cashCounted: number; variance: number };

export function MyDrawer() {
  const state = useApi<Drawer>("/api/drawer");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [closed, setClosed] = useState<Closed | null>(null);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          {closed ? (
            <div className={`rounded-md border p-3 text-sm ${closed.variance ? "border-warning/50 bg-warning/15" : "border-success/40 bg-success/10"}`} data-testid="drawer-closed">
              Drawer closed. Expected {formatINR(closed.cashExpected)}, counted {formatINR(closed.cashCounted)}
              {closed.variance ? ` — variance ${formatINR(closed.variance)} (the manager and accountant are notified).` : " — no variance."}
            </div>
          ) : null}
          {!d.open ? (
            <DrawerOpener onOpened={() => { setClosed(null); void state.reload(); }} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>{d.open.area.charAt(0) + d.open.area.slice(1).toLowerCase()} drawer · open since {fmtDateTime(d.open.openedAt)}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <DrawerBreakdown sessionId={d.open.id} collections={d.open.collections} total={d.open.totalCollected} />
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-secondary/50 p-3 text-sm" data-testid="cash-expected">
                  <span className="text-muted-foreground">Starting float</span><Money paise={d.open.openingFloat} className="text-right" />
                  <span className="text-muted-foreground">Cash taken</span><Money paise={d.open.cashIn} className="text-right" />
                  <span className="text-muted-foreground">Cash refunded</span><Money paise={-d.open.cashOut} className="text-right" />
                  <span className="font-semibold">Cash expected in the drawer</span><Money paise={d.open.cashExpected} className="text-right font-bold" />
                  <span className="col-span-2 text-xs text-muted-foreground">Count the cash only. UPI, card and online money is already with the bank or terminal and is not in the drawer.</span>
                </div>
                <Field label="Counted cash ₹"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} aria-label="Counted cash" /></Field>
                <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <RejectionBanner error={error} />
                <Button
                  size="lg"
                  onClick={async () => {
                    setError(null);
                    const cashCounted = parseRupees(counted || "");
                    if (cashCounted === null) return setError({ code: "VALIDATION_FAILED", message: "Count the cash and enter the amount." });
                    try {
                      setClosed(await api<Closed>("/api/drawer/close", { body: { cashCounted, note: note || undefined } }));
                      setCounted("");
                      setNote("");
                      await state.reload();
                    } catch (e) {
                      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                    }
                  }}
                >
                  Close drawer
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </DataState>
  );
}
