"use client";
// One counter payment (or refund) with the proof its method needs (completion pass §2):
// cash → amount tendered with the change to return and quick-tender buttons (v4 CD-3) · UPI → the 12-character UTR
// from the club's phone · card → approval code + last 4 · bank transfer (invoices only) → the transfer reference.
// Only enabled methods are offered.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { formatINR, parseRupees } from "@/lib/money";
import { upiLink } from "@/lib/upi";
import { api, ApiError, useApi } from "./api";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { METHOD_LABEL, useCapabilities } from "./capabilities";
import { DEFAULT_DENOMINATIONS, DenominationGrid, draftCounts, draftTotal, type CountDraft, type Denominations } from "./cash-count";
import { drawerChanged } from "./drawer-badge";

export type TenderMethod = "CASH" | "CARD" | "UPI" | "BANK_TRANSFER";
export type TenderDraft = { method: TenderMethod; amount: string; reference: string; tendered: string; cardLast4: string; approvalCode: string };

export const emptyTender = (method: TenderMethod, amount = ""): TenderDraft => ({ method, amount, reference: "", tendered: "", cardLast4: "", approvalCode: "" });

/** API body for a tender (amount handled by the caller). Throws a readable error when the proof is missing. */
export function tenderProof(t: TenderDraft, kind: "payment" | "refund" = "payment") {
  if (t.method === "UPI") {
    if (!/^[A-Za-z0-9]{12}$/.test(t.reference.trim())) throw new ApiError("VALIDATION_FAILED", "Enter the 12-character UPI reference (UTR) shown on the club's phone.", 422, null);
    return { method: t.method, reference: t.reference.trim() };
  }
  if (t.method === "CARD") {
    if (!/^[A-Za-z0-9]{4,12}$/.test(t.approvalCode.trim())) throw new ApiError("VALIDATION_FAILED", "Enter the card terminal's approval code.", 422, null);
    if (kind === "payment" && !/^\d{4}$/.test(t.cardLast4.trim())) throw new ApiError("VALIDATION_FAILED", "Enter the last 4 digits of the card.", 422, null);
    return { method: t.method, approvalCode: t.approvalCode.trim(), cardLast4: t.cardLast4.trim() || undefined, reference: kind === "refund" ? t.approvalCode.trim() : undefined };
  }
  if (t.method === "BANK_TRANSFER") return { method: t.method, reference: t.reference.trim() };
  const tendered = t.tendered ? parseRupees(t.tendered) : null;
  return { method: t.method, tendered: tendered ?? undefined };
}

/** Methods offered for counter payments: the enabled ones (+ bank transfer where allowed). */
export function useTenderMethods(opts: { bankTransfer?: boolean } = {}): TenderMethod[] | null {
  const caps = useCapabilities();
  if (!caps) return null;
  return [...caps.counterMethods, ...(opts.bankTransfer ? (["BANK_TRANSFER"] as const) : [])];
}

export function MethodSelect({ methods, value, onChange, className }: { methods: TenderMethod[]; value: TenderMethod; onChange: (m: TenderMethod) => void; className?: string }) {
  return (
    <Select className={className} value={value} onChange={(e) => onChange(e.target.value as TenderMethod)} aria-label="Method" name="method">
      {methods.map((m) => (
        <option key={m} value={m}>
          {METHOD_LABEL[m]}
        </option>
      ))}
    </Select>
  );
}

const toRupeeText = (paise: number) => (paise / 100).toFixed(paise % 100 ? 2 : 0);

/** v4 CD-3 quick-tender amounts: exact, the next ₹100 and the next ₹500 above the amount. */
export function quickTenders(amount: number): Array<{ label: string; paise: number }> {
  const next = (step: number) => (Math.ceil(amount / step) * step === amount ? amount + step : Math.ceil(amount / step) * step);
  const out = [{ label: "Exact", paise: amount }, { label: formatINR(next(10000)), paise: next(10000) }, { label: formatINR(next(50000)), paise: next(50000) }];
  return out.filter((t, i) => out.findIndex((x) => x.paise === t.paise) === i);
}

/**
 * v4 CD-3: cash tendered and the change to return. The drawer grows by the amount applied to the bill, never by the
 * tendered amount; the server refuses change the drawer can't give (INSUFFICIENT_CHANGE, CD-4).
 */
export function CashTender({ amount, tendered, onChange, className = "" }: { amount: number | null; tendered: string; onChange: (tendered: string) => void; className?: string }) {
  const t = tendered ? parseRupees(tendered) : null;
  const change = amount && t !== null ? t - amount : null;
  return (
    <div className={`flex flex-col gap-1 ${className}`} data-testid="cash-tender">
      <Input inputMode="decimal" placeholder="Tendered ₹" value={tendered} onChange={(e) => onChange(e.target.value)} aria-label="Cash tendered" />
      {amount ? (
        <div className="flex flex-wrap gap-1">
          {quickTenders(amount).map((q) => (
            <button key={q.label} type="button" className="rounded-full border border-input bg-card px-2.5 py-0.5 text-xs font-semibold hover:bg-secondary" onClick={() => onChange(toRupeeText(q.paise))} aria-label={`Tendered ${q.label === "Exact" ? "exact" : q.label}`}>
              {q.label}
            </button>
          ))}
        </div>
      ) : null}
      {change !== null ? (
        change >= 0 ? (
          <p className="text-sm" data-testid="change-due">Change to return: <span className="font-bold tabular">{formatINR(change)}</span></p>
        ) : (
          <p className="text-sm text-destructive">Tendered is {formatINR(-change)} less than the amount.</p>
        )
      ) : null}
    </div>
  );
}

/** The proof inputs for the chosen method. `due` is the amount being paid when the draft itself carries none. */
export function ProofFields({ value, onChange, kind = "payment", className = "", due }: { value: TenderDraft; onChange: (patch: Partial<TenderDraft>) => void; kind?: "payment" | "refund"; className?: string; due?: number | null }) {
  if (value.method === "CASH") {
    if (kind === "refund") return null;
    const amount = (value.amount ? parseRupees(value.amount) : null) ?? due ?? null;
    return <CashTender className={className} amount={amount} tendered={value.tendered} onChange={(tendered) => onChange({ tendered })} />;
  }
  if (value.method === "UPI") {
    return <Input className={className} name="reference" placeholder="UTR (12 characters)" maxLength={12} value={value.reference} onChange={(e) => onChange({ reference: e.target.value.trim() })} aria-label="UPI reference (UTR)" />;
  }
  if (value.method === "CARD") {
    return (
      <div className={`flex gap-2 ${className}`}>
        <Input name="approvalCode" placeholder="Approval code" maxLength={12} value={value.approvalCode} onChange={(e) => onChange({ approvalCode: e.target.value.trim() })} aria-label="Card approval code" />
        {kind === "payment" ? <Input name="cardLast4" placeholder="Last 4" inputMode="numeric" maxLength={4} className="w-20" value={value.cardLast4} onChange={(e) => onChange({ cardLast4: e.target.value.replace(/\D/g, "") })} aria-label="Card last 4 digits" /> : null}
      </div>
    );
  }
  return <Input className={className} name="reference" placeholder="Transfer reference (UTR / NEFT)" value={value.reference} onChange={(e) => onChange({ reference: e.target.value })} aria-label="Bank transfer reference" />;
}

/** QR for the club's confirmed UPI ID (only when UPI is enabled). */
export function UpiQr({ amountPaise, note }: { amountPaise: number | null; note: string }) {
  const caps = useCapabilities();
  const [qr, setQr] = useState<string | null>(null);
  const vpa = caps?.upiVpa ?? null;
  useEffect(() => {
    if (!vpa || !amountPaise) return;
    let cancelled = false;
    QRCode.toDataURL(upiLink({ vpa, payee: caps?.clubName || "Club", amountPaise, note }), { width: 160, margin: 1 })
      .then((d) => !cancelled && setQr(d))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [vpa, amountPaise, note, caps?.clubName]);
  if (!vpa || !amountPaise || !qr) return null;
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="UPI QR code" className="h-28 w-28" />
      <p className="text-xs text-muted-foreground">
        Customer scans to pay {formatINR(amountPaise)} to <span className="font-mono">{vpa}</span>. Enter the UTR from the club&apos;s phone once it arrives.
      </p>
    </div>
  );
}

type TillOption = {
  id: string; name: string; location: "FRONT_DESK" | "SHOP" | "BAR" | "OFFICE"; defaultFloat: number;
  openSession: { userName: string; mine: boolean } | null; lastClose: { floatCarried: number | null } | null;
};
const LOCATION_OF = { DESK: "FRONT_DESK", SHOP: "SHOP", BAR: "BAR", OFFICE: "OFFICE" } as const;

/**
 * Open a drawer (v4 §2.3): choose the till and count the float by denomination; the total is computed. Shown on the
 * drawer page and wherever the server says DRAWER_NOT_OPEN, then the action is retried.
 */
export function DrawerOpener({ onOpened, defaultArea = "DESK" }: { onOpened: () => void; defaultArea?: "DESK" | "SHOP" | "BAR" | "OFFICE" }) {
  const tills = useApi<TillOption[]>("/api/drawer/tills");
  const rules = useApi<{ rules: { denominations: Denominations } }>("/api/drawer");
  const [tillId, setTillId] = useState("");
  const [area, setArea] = useState(defaultArea);
  const [counts, setCounts] = useState<CountDraft>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = tills.data ?? [];
  const free = list.filter((t) => !t.openSession);
  const chosen = list.find((t) => t.id === tillId) ?? free.find((t) => t.location === LOCATION_OF[defaultArea]) ?? free[0] ?? null;
  const total = draftTotal(counts);
  const carried = chosen?.lastClose?.floatCarried ?? null;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warning/50 bg-warning/15 p-3 text-sm text-warning-foreground" data-testid="drawer-opener">
      <p className="font-medium">Open your cash drawer first: count the starting float.</p>
      {tills.data && list.length === 0 ? (
        // No tills set up yet (a new club): the drawer is opened for a location and a till is added for it.
        <Select value={area} onChange={(e) => setArea(e.target.value as typeof area)} aria-label="Drawer" className="w-40">
          <option value="DESK">Front desk</option>
          <option value="SHOP">Shop</option>
          <option value="BAR">Bar</option>
          <option value="OFFICE">Office</option>
        </Select>
      ) : (
        <div className="flex flex-col gap-1">
          <Select value={chosen?.id ?? ""} onChange={(e) => setTillId(e.target.value)} aria-label="Till" className="max-w-xs">
            {list.map((t) => (
              <option key={t.id} value={t.id} disabled={!!t.openSession}>
                {t.name}{t.openSession ? ` — open by ${t.openSession.mine ? "you" : t.openSession.userName}` : ""}
              </option>
            ))}
          </Select>
          {chosen ? (
            <span className="text-xs text-foreground/80">
              Default float {formatINR(chosen.defaultFloat)}
              {carried !== null ? ` · ${formatINR(carried)} was left in it at the last close` : ""}
            </span>
          ) : list.length ? <span className="text-xs">Every till is in use — ask whoever has one open to hand it over.</span> : null}
        </div>
      )}
      <div className="rounded-xl bg-card p-3 text-foreground">
        <DenominationGrid denominations={rules.data?.rules.denominations ?? DEFAULT_DENOMINATIONS} value={counts} onChange={setCounts} testId="opening-count" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || (list.length > 0 && !chosen)}
          onClick={async () => {
            setErr(null);
            const c = draftCounts(counts);
            if (!c) return setErr("Enter whole numbers of notes and coins.");
            setBusy(true);
            try {
              await api("/api/drawer/open", { body: chosen ? { drawerId: chosen.id, counts: c } : { area, counts: c } });
              setCounts({});
              drawerChanged();
              await tills.reload();
              onOpened();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Opening…" : `Open drawer${total ? ` with ${formatINR(total)}` : ""}`}
        </Button>
      </div>
      {err ? <p className="text-destructive" role="alert">{err}</p> : null}
    </div>
  );
}

// ───────── refunds ─────────

export type RefundDraft = { method: "" | "CASH" | "CARD" | "UPI"; reference: string };
export const emptyRefund = (): RefundDraft => ({ method: "", reference: "" });

/** Body fields for a refund choice: blank → the server decides (gateway, cash back, or "to be paid at the desk"). */
export function refundBody(r: RefundDraft): { refundMethod?: "CASH" | "CARD" | "UPI"; refundReference?: string } {
  if (!r.method) return {};
  if (r.method === "UPI" && !/^[A-Za-z0-9]{12}$/.test(r.reference.trim())) throw new ApiError("VALIDATION_FAILED", "Enter the 12-character UTR of the UPI refund you sent.", 422, null);
  if (r.method === "CARD" && !/^[A-Za-z0-9]{4,12}$/.test(r.reference.trim())) throw new ApiError("VALIDATION_FAILED", "Enter the card terminal's refund approval code.", 422, null);
  return { refundMethod: r.method, refundReference: r.method === "CASH" ? undefined : r.reference.trim() };
}

/** Refund method + proof. Only enabled methods are offered; leaving it blank lets the server pick or queue it. */
export function RefundFields({ value, onChange }: { value: RefundDraft; onChange: (r: RefundDraft) => void }) {
  const caps = useCapabilities();
  const methods = caps?.counterMethods ?? ["CASH"];
  return (
    <div className="flex flex-col gap-2">
      <Select value={value.method} onChange={(e) => onChange({ method: e.target.value as RefundDraft["method"], reference: "" })} aria-label="Refund method">
        <option value="">Same way it was paid (or pay out later at the desk)</option>
        {methods.map((m) => (
          <option key={m} value={m}>
            {METHOD_LABEL[m]} now
          </option>
        ))}
      </Select>
      {value.method === "UPI" || value.method === "CARD" ? (
        <Input
          placeholder={value.method === "UPI" ? "UTR of the refund (12 characters)" : "Refund approval code"}
          maxLength={12}
          value={value.reference}
          onChange={(e) => onChange({ ...value, reference: e.target.value.trim() })}
          aria-label="Refund reference"
        />
      ) : null}
    </div>
  );
}

/** "₹X refunded · ₹Y to pay out at the desk" */
export function refundSummary(refunded: number, pending = 0): string {
  const parts = [];
  if (refunded) parts.push(`${formatINR(refunded)} refunded`);
  if (pending) parts.push(`${formatINR(pending)} to be paid out at the desk`);
  return parts.join(" · ");
}
