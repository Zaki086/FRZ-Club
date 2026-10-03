// v4 RF-9 step 5: the 80 mm refund receipt — refund code, amount, original bill, who paid it out and when, and a
// signature line. Rendered by the staff print page (printed at the desk) and the member's portal copy.
import type { ReactNode } from "react";
import type { refundReceipt } from "@/server/services/refunds";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

export type RefundReceiptData = Awaited<ReturnType<typeof refundReceipt>>;

export function RefundReceipt({ r, children }: { r: RefundReceiptData; children?: ReactNode }) {
  return (
    <div className="receipt mx-auto font-mono text-[12px] leading-snug text-black" data-testid="refund-receipt">
      <style>{`@page { size: 80mm auto; margin: 0 } .receipt { width: 72mm; padding: 4mm 0; background: #fff } @media screen { .receipt { margin-top: 1rem; padding: 4mm; border: 1px dashed #999 } }`}</style>
      <div className="text-center">
        <p className="text-[14px] font-bold">{r.club.name}</p>
        {r.club.address ? <p>{r.club.address}</p> : null}
        {r.club.phone ? <p>{r.club.phone}</p> : null}
        <p className="mt-1 font-bold">REFUND RECEIPT</p>
      </div>
      <p className="mt-2">Refund: <b>{r.code}</b></p>
      <p>{r.customer}{r.memberCode ? ` · ${r.memberCode}` : ""}</p>
      <hr className="my-1 border-dashed border-black" />
      <p>Original bill: {r.original.code ?? "—"}</p>
      <p>{r.original.what}</p>
      <p className="flex justify-between"><span>Bill of {fmtDateTime(r.original.at)}</span><span>{formatINR(r.original.total)}</span></p>
      <p>Reason: {r.reason}</p>
      <hr className="my-1 border-dashed border-black" />
      {r.paidOut.map((p, i) => (
        <p key={i} className="flex justify-between"><span>Refunded ({p.methodLabel})</span><span>{formatINR(p.amount)}</span></p>
      ))}
      <p className="flex justify-between text-[14px] font-bold"><span>TOTAL REFUNDED</span><span>{formatINR(r.amount)}</span></p>
      <hr className="my-1 border-dashed border-black" />
      <p>Paid out: {r.completedAt ? fmtDateTime(r.completedAt) : "—"}</p>
      <p>By: {r.paidOut.map((p) => p.by).filter(Boolean).join(", ") || "—"}{r.paidOut[0]?.where ? ` (${r.paidOut[0].where})` : ""}</p>
      {r.identityCheckedBy ? <p>Identity checked by {r.identityCheckedBy}</p> : null}
      {r.approvedBy ? <p>Approved: {r.approvedBy}</p> : null}
      <div className="mt-8 border-t border-black pt-1 text-center">Received by (signature)</div>
      <p className="mt-2 text-center text-[10px]">Printed {fmtDateTime(r.printedAt)}</p>
      {children}
    </div>
  );
}
