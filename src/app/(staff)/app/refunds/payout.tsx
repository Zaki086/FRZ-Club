"use client";
// v4 RF-9: paying a refund out at the desk.
// 1. Find it: scan the member's refund QR or member card (camera or a USB scanner typing into the box), or search by
//    name, phone, member code, refund code or the original booking/order code.
// 2. Check the person: the member's photo is on screen and "Identity checked" must be ticked (the server refuses a
//    pay-out without it). Guests give their phone number and the original booking/order code.
// 3. Pay from the open drawer (cash by default; the drawer must hold the cash — otherwise "Pay in cash first").
// 4. Print the 80 mm refund receipt.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Printer, QrCode, Search, ShieldCheck, UserRound } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Money } from "@/components/money";
import { QrScanner } from "@/components/qr-scanner";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

export type IdentityMethod = "REFUND_QR" | "MEMBER_CARD" | "SEARCH" | "GUEST_PHONE_CODE";
export type Collectable = {
  id: string; code: string; status: string; collectStatus: string | null; amount: number; toCollect: number; readyAt: string | null;
  what: string; billId: string; customer: string; reason: string;
  member: { id: string; name: string; memberCode: string; phone: string; photoUrl: string | null; guardianName: string | null } | null;
  guest: { needsPhone: boolean; needsCode: boolean; codeLabel: string } | null;
};

function Photo({ r }: { r: Collectable }) {
  if (r.member?.photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- member photo from the uploads route
    return <img src={r.member.photoUrl} alt={`Photo of ${r.member.name}`} className="h-28 w-28 rounded-2xl object-cover" data-testid="payout-photo" />;
  }
  return (
    <div className="flex h-28 w-28 flex-col items-center justify-center rounded-2xl bg-muted text-center text-xs text-muted-foreground" data-testid="payout-photo">
      <UserRound className="h-8 w-8" />
      {r.member ? "No photo on file — check the member card or ID" : "Guest"}
    </div>
  );
}

/** Steps 2–4 for one refund: who it is, the identity tick, the method, pay out, print. */
export function PayOutForm({ refund, via = "SEARCH", onDone }: { refund: Collectable; via?: IdentityMethod; onDone?: () => void }) {
  const methods = useTenderMethods() ?? ["CASH"];
  const [t, setT] = useState<TenderDraft>(emptyTender("CASH"));
  const [checked, setChecked] = useState(false);
  const [guestPhone, setGuestPhone] = useState("");
  const [originalCode, setOriginalCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [paid, setPaid] = useState<{ amount: number } | null>(null);
  if (paid) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-success/40 bg-success/10 p-4" data-testid="refund-paid-out">
        <p className="font-semibold text-success-text">Paid out {formatINR(paid.amount)} · {refund.code} is collected.</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/print/refund/${refund.id}`} target="_blank"><Printer className="h-4 w-4" /> Print refund receipt</Link>
          </Button>
          {onDone ? <Button variant="outline" onClick={onDone}>Done</Button> : null}
        </div>
      </div>
    );
  }
  const amount = refund.toCollect || refund.amount;
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const proof = tenderProof(t, "refund");
      await api(`/api/refunds/${refund.id}/pay-out`, {
        body: {
          method: proof.method, reference: "reference" in proof ? proof.reference : undefined, approvalCode: "approvalCode" in proof ? proof.approvalCode : undefined,
          identityChecked: checked, via, guestPhone: refund.guest ? guestPhone : undefined, originalCode: refund.guest ? originalCode : undefined,
        },
      });
      setPaid({ amount });
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()} data-testid="refund-payout">
      <div className="flex flex-wrap items-start gap-4">
        <Photo r={refund} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <p className="text-lg font-bold">{refund.member?.name ?? refund.customer}</p>
          {refund.member ? (
            <p className="text-muted-foreground"><span className="font-mono">{refund.member.memberCode}</span> · {refund.member.phone}</p>
          ) : (
            <Badge tone="amber" className="self-start">Guest — check phone and original code</Badge>
          )}
          {refund.member?.guardianName ? <p className="text-xs text-muted-foreground">Junior: may be collected by the guardian, {refund.member.guardianName}.</p> : null}
          <p className="mt-1">
            <span className="font-mono font-semibold">{refund.code}</span> · <Money paise={amount} className="font-bold" /> for {refund.what}
          </p>
          <p className="text-xs text-muted-foreground">{refund.reason}{refund.readyAt ? ` · ready since ${fmtDateTime(refund.readyAt)}` : ""}</p>
        </div>
      </div>
      {refund.guest ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {refund.guest.needsPhone ? (
            <Field label="Guest's phone number"><Input inputMode="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="The number they booked with" /></Field>
          ) : null}
          {refund.guest.needsCode ? (
            <Field label={`Original ${refund.guest.codeLabel}`}><Input value={originalCode} onChange={(e) => setOriginalCode(e.target.value)} placeholder="Ask the guest — e.g. BK-000123" /></Field>
          ) : null}
        </div>
      ) : null}
      <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", checked ? "border-success bg-success/10" : "border-warning/60 bg-warning/10")}>
        <input type="checkbox" className="mt-1 h-5 w-5" checked={checked} onChange={(e) => setChecked(e.target.checked)} aria-label="Identity checked" data-testid="identity-checked" />
        <span className="text-sm">
          <span className="flex items-center gap-1 font-semibold"><ShieldCheck className="h-4 w-4" /> Identity checked</span>
          {refund.member ? "The person collecting matches the photo on screen (or is the Junior's guardian)." : "The guest gave the phone number and the original code above."}
        </span>
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <MethodSelect methods={methods.filter((m) => m !== "BANK_TRANSFER")} value={t.method} onChange={(m) => setT({ ...t, method: m })} />
        <ProofFields kind="refund" className="sm:col-span-2" value={t} onChange={(p) => setT({ ...t, ...p })} />
        <Button disabled={busy || !checked} onClick={submit}>{busy ? "Paying…" : `Pay out ${formatINR(amount)}`}</Button>
      </div>
      {error?.code === "DRAWER_NOT_OPEN" ? (
        <DrawerOpener onOpened={() => setError(null)} />
      ) : error?.code === "INSUFFICIENT_CASH_IN_DRAWER" ? (
        <div role="alert" className="flex flex-col gap-1 rounded-xl border border-warning/60 bg-warning/15 p-3 text-sm" data-testid="pay-in-first">
          <p className="font-semibold">Pay in cash first</p>
          <p>{error.message}</p>
          <Link className="font-semibold text-primary underline" href="/app/drawer" target="_blank">Open My Cash Drawer → Pay in</Link>
        </div>
      ) : (
        <RejectionBanner error={error} />
      )}
    </div>
  );
}

/** Loads one refund as the pay-out form needs it (from a queue row or the refund page). */
export function PayOutLoader({ id, onDone }: { id: string; onDone?: () => void }) {
  const state = useApi<Collectable>(`/api/refunds/${id}/collect`);
  if (state.error) return <RejectionBanner error={{ code: state.error.code, message: state.error.message }} />;
  if (!state.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <PayOutForm refund={state.data} onDone={onDone} />;
}

/** Step 1: scan or search, then pick the refund to pay out. */
export function FindRefund({ onPick, autoFocus = true }: { onPick: (r: Collectable, via: IdentityMethod) => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [scan, setScan] = useState(false);
  const [result, setResult] = useState<{ via: IdentityMethod; refunds: Collectable[] } | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const run = useCallback(async (q: string) => {
    setError(null);
    try {
      setResult(await api<{ via: IdentityMethod; refunds: Collectable[] }>("/api/refunds/collect", { body: { text: q } }));
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    }
  }, []);
  const term = text.trim();
  const isCode = term.startsWith("RF1.") || term.startsWith("CC1.");
  useEffect(() => {
    if (isCode || term.length < 2) return;
    const h = setTimeout(() => void run(term), 300);
    return () => clearTimeout(h);
  }, [term, isCode, run]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-12 pl-9 text-base"
            placeholder="Name, phone, RF-000123, booking code — or scan the refund QR / member card"
            aria-label="Find a refund"
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && term) void run(term);
            }}
            data-testid="refund-find"
          />
        </div>
        <Button size="lg" variant="outline" onClick={() => setScan(true)}><QrCode className="h-5 w-5" /> Scan</Button>
      </div>
      {scan ? (
        <QrScanner
          onScan={(t) => {
            setScan(false);
            setText(t);
            void run(t);
          }}
          onClose={() => setScan(false)}
        />
      ) : null}
      <RejectionBanner error={error} />
      {result && result.refunds.length === 0 && (term.length >= 2 || isCode) ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting to be collected for “{term}”.</p>
      ) : null}
      {result?.refunds.length ? (
        <div className="divide-y rounded-2xl border">
          {result.refunds.map((r) => (
            <button key={r.id} type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-secondary" onClick={() => onPick(r, result.via)} aria-label={`Pay out ${r.code}`}>
              {r.member?.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- member photo
                <img src={r.member.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted font-bold">{(r.member?.name ?? r.customer).charAt(0)}</div>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{r.member?.name ?? r.customer} {r.member ? null : <Badge tone="amber">Guest</Badge>}</span>
                <span className="truncate text-xs text-muted-foreground"><span className="font-mono">{r.code}</span> · {r.what}</span>
              </span>
              <Money paise={r.toCollect || r.amount} className="font-bold" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The front desk's "Pay out a refund" dialog: find → check → pay → print. */
export function PayOutDialog({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ r: Collectable; via: IdentityMethod } | null>(null);
  const close = () => {
    setOpen(false);
    setPicked(null);
    onChanged?.();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Button onClick={() => setOpen(true)} data-testid="open-payout"><QrCode className="h-4 w-4" /> Pay out a refund</Button>
      <DialogContent wide title="Pay out a refund" description="Scan the refund QR or member card, or search. Check the person, then pay from your drawer.">
        {picked ? (
          <div className="flex flex-col gap-3">
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setPicked(null)}>← Find another</Button>
            <PayOutForm refund={picked.r} via={picked.via} onDone={close} />
          </div>
        ) : (
          <FindRefund onPick={(r, via) => setPicked({ r, via })} />
        )}
      </DialogContent>
    </Dialog>
  );
}
