"use client";
// One counter payment (or refund) with the proof its method needs (completion pass §2):
// cash → optional amount tendered · UPI → the 12-character UTR from the club's phone · card → approval code + last 4
// · bank transfer (invoices only) → the transfer reference. Only enabled methods are offered.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { formatINR, parseRupees } from "@/lib/money";
import { upiLink } from "@/lib/upi";
import { api, ApiError } from "./api";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { METHOD_LABEL, useCapabilities } from "./capabilities";

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

/** The proof inputs for the chosen method. */
export function ProofFields({ value, onChange, kind = "payment", className = "" }: { value: TenderDraft; onChange: (patch: Partial<TenderDraft>) => void; kind?: "payment" | "refund"; className?: string }) {
  if (value.method === "CASH") {
    if (kind === "refund") return null;
    return <Input className={className} inputMode="decimal" placeholder="Tendered ₹ (optional)" value={value.tendered} onChange={(e) => onChange({ tendered: e.target.value })} aria-label="Cash tendered" />;
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

/** Shown when the server says DRAWER_NOT_OPEN: open the drawer right here, then retry. */
export function DrawerOpener({ onOpened, defaultArea = "DESK" }: { onOpened: () => void; defaultArea?: "DESK" | "SHOP" | "BAR" | "OFFICE" }) {
  const [area, setArea] = useState(defaultArea);
  const [float, setFloat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="drawer-opener">
      <p className="font-medium">Open your cash drawer first: count the starting float.</p>
      <div className="flex flex-wrap gap-2">
        <Select value={area} onChange={(e) => setArea(e.target.value as typeof area)} aria-label="Drawer" className="w-32">
          <option value="DESK">Front desk</option>
          <option value="SHOP">Shop</option>
          <option value="BAR">Bar</option>
          <option value="OFFICE">Office</option>
        </Select>
        <Input className="w-36" inputMode="decimal" placeholder="Float ₹" value={float} onChange={(e) => setFloat(e.target.value)} aria-label="Opening float" />
        <Button
          type="button"
          size="sm"
          onClick={async () => {
            setErr(null);
            try {
              await api("/api/drawer/open", { body: { area, openingFloat: float ? (parseRupees(float) ?? 0) : 0 } });
              onOpened();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Open drawer
        </Button>
      </div>
      {err ? <p className="text-red-700">{err}</p> : null}
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
