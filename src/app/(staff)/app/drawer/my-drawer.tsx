"use client";
// v4 §2.4 "My Cash Drawer" — one screen for the front desk, shop and bar: the till, "Cash in drawer now", the summary
// strip, the movement list (FilterBar: type, time) with the running balance, and Pay in · Pay out · Cash drop · Close.
// Card/UPI/online collections appear in a separate panel and never mix into the cash figure.
import { useState, type ReactNode } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { DrawerOpener } from "@/components/tender-fields";
import { DrawerBreakdown, type Collection } from "@/components/drawer-breakdown";
import { DEFAULT_DENOMINATIONS, DenominationGrid, draftCounts, draftTotal, type CountDraft, type Denominations } from "@/components/cash-count";
import { drawerChanged } from "@/components/drawer-badge";
import { FilteredList } from "@/components/list/filtered-list";
import { MovementAmount, MovementBill, MovementDetail, MovementType, type MovementRow } from "@/components/drawer-movements";
import { useCapabilities } from "@/components/capabilities";
import { InfoTip } from "@/components/info-tip";
import { fmtDateTime } from "@/lib/time";
import { formatINR, parseRupees } from "@/lib/money";

type Stat = { count: number; amount: number };
type Rules = { blindClose: boolean; tolerance: number; denominations: Denominations };
type Open = {
  id: string; name: string; area: string; openedAt: string; openingFloat: number; defaultFloat: number; balance: number; cashExpected: number;
  summary: { openingFloat: number; sales: Stat; refunds: Stat; payIns: Stat; payOuts: Stat; drops: Stat };
  collections: Collection[]; totalCollected: number;
};
type Last = { id: string; status: string; name: string; closedAt: string; cashExpected: number | null; cashCounted: number | null; variance: number | null; varianceReason: string | null; floatCarried: number | null; cashDropped: number | null; rejectionReason: string | null };
type Drawer = { open: Open | null; last: Last | null; rules: Rules };
type Closed = Last & { needsApproval: boolean; needsReason: boolean; tolerance: number };

type Err = { code?: string; message: string } | null;
const errOf = (e: unknown): Err => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });

function StatTile({ label, stat, money, testId }: { label: string; stat?: Stat; money?: number; testId?: string }) {
  return (
    <div className="flex flex-col rounded-2xl border bg-card p-3 shadow-soft" data-testid={testId}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="font-display text-xl font-bold tabular">{formatINR(stat ? stat.amount : (money ?? 0))}</span>
      {stat ? <span className="text-xs text-muted-foreground">{stat.count} {stat.count === 1 ? "entry" : "entries"}</span> : null}
    </div>
  );
}

/** A small amount + text form in a dialog (pay in, pay out, cash drop). */
function MoveDialog({ open, onOpenChange, title, description, children, submit, label }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; submit: () => Promise<unknown>; label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setError(null); onOpenChange(o); }}>
      <DialogContent title={title} description={description}>
        <div className="flex flex-col gap-3">
          {children}
          <RejectionBanner error={error} />
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await submit();
                drawerChanged();
                onOpenChange(false);
              } catch (e) {
                setError(errOf(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function amountOrThrow(text: string): number {
  const a = parseRupees(text || "");
  if (!a) throw new ApiError("VALIDATION_FAILED", "Enter the amount in ₹.", 422, null);
  return a;
}

function Actions({ d, rules, onChanged, onClosed }: { d: Open; rules: Rules; onChanged: () => void; onClosed: (c: Closed) => void }) {
  const [dlg, setDlg] = useState<null | "in" | "out" | "drop" | "close">(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("OTHER");
  const [paidTo, setPaidTo] = useState("");
  const [bag, setBag] = useState("");
  const open = (k: typeof dlg) => { setAmount(""); setReason(""); setPaidTo(""); setBag(""); setCategory("OTHER"); setDlg(k); };
  const done = () => onChanged();
  return (
    <>
      <div className="flex flex-wrap gap-2" data-testid="drawer-actions">
        <Button variant="outline" onClick={() => open("in")}>Pay in</Button>
        <Button variant="outline" onClick={() => open("out")}>Pay out</Button>
        <Button variant="outline" onClick={() => open("drop")}>Cash drop</Button>
        <Button onClick={() => setDlg("close")}>Close drawer</Button>
      </div>
      <MoveDialog open={dlg === "in"} onOpenChange={(o) => setDlg(o ? "in" : null)} title="Pay in" label="Add to drawer"
        submit={async () => { await api("/api/drawer/pay-in", { body: { amount: amountOrThrow(amount), reason } }); done(); }}>
        <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Change for the evening rush" /></Field>
      </MoveDialog>
      <MoveDialog open={dlg === "out"} onOpenChange={(o) => setDlg(o ? "out" : null)} title="Pay out" label="Pay out"
        submit={async () => { await api("/api/drawer/pay-out", { body: { amount: amountOrThrow(amount), reason, category, paidTo: paidTo.trim() || undefined } }); done(); }}>
        <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="MAINTENANCE">Maintenance</option>
            <option value="UTILITIES">Utilities</option>
            <option value="STOCK_PURCHASE">Stock purchase</option>
            <option value="MARKETING">Marketing</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bulbs for court 3" /></Field>
        <Field label="Paid to (optional)"><Input value={paidTo} onChange={(e) => setPaidTo(e.target.value)} placeholder="Shop or person" /></Field>
      </MoveDialog>
      <MoveDialog open={dlg === "drop"} onOpenChange={(o) => setDlg(o ? "drop" : null)} title="Cash drop" label="Drop to safe"
        submit={async () => { await api("/api/drawer/drop", { body: { amount: amountOrThrow(amount), bagRef: bag } }); done(); }}>
        <Field label="Amount ₹"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Sealed bag no."><Input value={bag} onChange={(e) => setBag(e.target.value)} /></Field>
      </MoveDialog>
      <CloseDialog open={dlg === "close"} onOpenChange={(o) => setDlg(o ? "close" : null)} d={d} rules={rules} onClosed={(c) => { onClosed(c); done(); }} />
    </>
  );
}

/** CD-5…CD-7: blind count by denomination → expected, counted, variance; float left in the till vs drop to the safe. */
function CloseDialog({ open, onOpenChange, d, rules, onClosed }: { open: boolean; onOpenChange: (o: boolean) => void; d: Open; rules: Rules; onClosed: (c: Closed) => void }) {
  const [counts, setCounts] = useState<CountDraft>({});
  const [carry, setCarry] = useState<string | null>(null);
  const [bag, setBag] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const total = draftTotal(counts) ?? 0;
  const suggested = Math.min(d.defaultFloat, total);
  const carryText = carry ?? (suggested ? (suggested / 100).toFixed(0) : "0");
  const carried = parseRupees(carryText || "0");
  const drop = carried === null ? null : total - carried;
  return (
    <Dialog open={open} onOpenChange={(o) => { setError(null); onOpenChange(o); }}>
      <DialogContent title={`Close ${d.name}`} description={rules.blindClose ? undefined : `Expected in the drawer: ${formatINR(d.balance)}.`} wide>
        <div className="flex flex-col gap-3" data-testid="close-drawer">
          {rules.blindClose ? (
            <p className="flex items-center gap-1 text-sm font-semibold">
              Blind count
              <InfoTip place="blind-count" label="About the blind count">
                Count every note and coin by denomination. The expected amount is shown only after you submit, so the count can&apos;t be steered towards it.
              </InfoTip>
            </p>
          ) : null}
          <DenominationGrid denominations={rules.denominations ?? DEFAULT_DENOMINATIONS} value={counts} onChange={setCounts} testId="closing-count" />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Leave in the till for the next shift ₹" hint={`Default float ${formatINR(d.defaultFloat)}. The rest goes to the safe.`}>
              <Input inputMode="decimal" value={carryText} onChange={(e) => setCarry(e.target.value)} aria-label="Float left in the till" />
            </Field>
            <Field label="Sealed bag no." hint={drop !== null && drop > 0 ? `${formatINR(drop)} to the safe` : "Nothing goes to the safe"}>
              <Input value={bag} onChange={(e) => setBag(e.target.value)} aria-label="Sealed bag no." />
            </Field>
          </div>
          <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <RejectionBanner error={error} />
          <Button
            size="lg"
            disabled={busy}
            onClick={async () => {
              setError(null);
              const c = draftCounts(counts);
              if (!c) return setError({ code: "VALIDATION_FAILED", message: "Enter whole numbers of notes and coins." });
              if (carried === null || carried > total) return setError({ code: "VALIDATION_FAILED", message: "The float left in the till can't be more than you counted." });
              if (total - carried > 0 && bag.trim().length < 2) return setError({ code: "VALIDATION_FAILED", message: "Enter the sealed bag's number for the cash going to the safe." });
              setBusy(true);
              try {
                const r = await api<Closed>("/api/drawer/close", { body: { counts: c, floatCarried: carried, bagRef: bag.trim() || undefined, note: note.trim() || undefined } });
                setCounts({}); setCarry(null); setBag(""); setNote("");
                drawerChanged();
                onClosed(r);
                onOpenChange(false);
              } catch (e) {
                setError(errOf(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Closing…" : "Count done — close drawer"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** After the close: expected, counted, variance; over the tolerance the reason is asked and approval waits. */
function ClosedResult({ c, onReason }: { c: Last; onReason: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const variance = c.variance ?? 0;
  const pending = c.status === "PENDING_APPROVAL";
  const askReason = pending && !c.varianceReason;
  return (
    <div className={`flex flex-col gap-2 rounded-2xl border p-3 text-sm ${variance ? "border-warning/50 bg-warning/15" : "border-success/40 bg-success/10"}`} data-testid="drawer-closed">
      <p className="font-semibold">{c.name} closed.</p>
      <div className="grid max-w-sm grid-cols-2 gap-1">
        <span>Expected</span><Money paise={c.cashExpected ?? 0} className="text-right" />
        <span>Counted</span><Money paise={c.cashCounted ?? 0} className="text-right" />
        <span>Variance</span><span className="text-right font-semibold">{variance ? formatINR(variance) : "none"}</span>
        <span>Left in the till</span><Money paise={c.floatCarried ?? 0} className="text-right" />
        <span>To the safe</span><Money paise={c.cashDropped ?? 0} className="text-right" />
      </div>
      <p>
        {variance === 0
          ? "Counted exactly — no variance."
          : pending
            ? `Variance ${formatINR(variance)} is over the tolerance — it waits for a manager's approval.`
            : c.status === "APPROVED" ? `Variance ${formatINR(variance)} — approved.` : c.status === "REJECTED" ? `Variance ${formatINR(variance)} — not accepted${c.rejectionReason ? `: ${c.rejectionReason}` : ""}.` : `Variance ${formatINR(variance)} — within the tolerance (the manager and accountant are notified).`}
      </p>
      {askReason ? (
        <div className="flex flex-col gap-2">
          <Field label="Why is the count different? (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Variance reason" /></Field>
          <RejectionBanner error={error} />
          <Button size="sm" disabled={busy} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/api/drawer/sessions/${c.id}/reason`, { body: { reason } });
              onReason();
            } catch (e) {
              setError(errOf(e));
            } finally {
              setBusy(false);
            }
          }}>Send for approval</Button>
        </div>
      ) : c.varianceReason ? <p className="text-muted-foreground">Reason given: {c.varianceReason}</p> : null}
    </div>
  );
}

export function MyDrawer({ defaultArea = "DESK" }: { defaultArea?: "DESK" | "SHOP" | "BAR" | "OFFICE" }) {
  const state = useApi<Drawer>("/api/drawer", { pollMs: 5000 });
  const caps = useCapabilities();
  const [closed, setClosed] = useState<Closed | null>(null);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          {!d.open ? (
            <>
              {closed ? <ClosedResult c={closed} onReason={() => { setClosed(null); void state.reload(); }} /> : d.last ? <ClosedResult c={d.last} onReason={() => void state.reload()} /> : null}
              <DrawerOpener defaultArea={defaultArea} onOpened={() => { setClosed(null); void state.reload(); }} />
            </>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {d.open.name} <Badge tone="green">Open</Badge>
                    <span className="text-sm font-normal text-muted-foreground">drawer · open since {fmtDateTime(d.open.openedAt)}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col" data-testid="cash-in-drawer">
                    <span className="text-sm font-semibold text-muted-foreground">Cash in drawer now</span>
                    <span className="font-display text-5xl font-bold tabular" data-testid="cash-in-drawer-amount">{formatINR(d.open.balance)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="cash-expected">
                    <StatTile label="Opening float" money={d.open.summary.openingFloat} />
                    <StatTile label="Cash sales" stat={d.open.summary.sales} testId="stat-sales" />
                    <StatTile label="Cash refunds" stat={d.open.summary.refunds} testId="stat-refunds" />
                    <StatTile label="Pay-ins" stat={d.open.summary.payIns} />
                    <StatTile label="Pay-outs" stat={d.open.summary.payOuts} />
                    <StatTile label="Drops" stat={d.open.summary.drops} />
                  </div>
                  <Actions d={d.open} rules={d.rules} onChanged={() => void state.reload()} onClosed={(c) => { setClosed(c); void state.reload(); }} />
                </CardContent>
              </Card>
              {caps && (caps.counterMethods.some((m) => m !== "CASH") || caps.online || d.open.collections.some((c) => c.method !== "CASH" && c.amount)) ? (
                <Card>
                  <CardHeader><CardTitle>Collected by other methods</CardTitle></CardHeader>
                  <CardContent>
                    <DrawerBreakdown
                      sessionId={d.open.id}
                      collections={d.open.collections.filter((c) => c.method !== "CASH")}
                      total={d.open.collections.filter((c) => c.method !== "CASH").reduce((a, c) => a + c.amount, 0)}
                    />
                  </CardContent>
                </Card>
              ) : null}
            </>
          )}
          {d.open || d.last ? (
            <Card>
              <CardHeader><CardTitle>Movements {d.open ? "" : `· ${d.last?.name ?? ""}`}</CardTitle></CardHeader>
              <CardContent>
                <FilteredList<MovementRow>
                  list="my-drawer-movements"
                  searchPlaceholder="Customer, refund code, note"
                  pollMs={5000}
                  columns={[
                    { key: "n", header: "#", className: "w-10 text-xs text-muted-foreground", cell: (m) => m.line_no },
                    { key: "at", header: "Time", cell: (m) => <span className="whitespace-nowrap text-xs">{fmtDateTime(m.at)}</span> },
                    { key: "type", header: "Type", cell: (m) => <MovementType type={m.type} /> },
                    { key: "what", header: "Details", cell: (m) => <MovementDetail m={m} /> },
                    { key: "amount", header: "Amount", className: "text-right", cell: (m) => <MovementAmount m={m} /> },
                    { key: "balance", header: "Balance", className: "text-right", cell: (m) => <Money paise={m.balance_after} className="font-semibold" /> },
                  ]}
                  rowExtra={(m) => (m.bill_id ? <MovementBill billId={m.bill_id} /> : null)}
                  empty={{ title: "No movements match these filters" }}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </DataState>
  );
}
