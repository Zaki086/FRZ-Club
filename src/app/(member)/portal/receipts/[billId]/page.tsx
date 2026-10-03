import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { isDomainError } from "@/server/errors";
import { myBillReceipt } from "@/server/services/refunds";
import { getSettings } from "@/server/services/settings";
import { PrintButton } from "@/components/print-button";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Receipt" };

const METHOD: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK_TRANSFER: "Bank transfer", ONLINE: "Online" };

/** v4 §3.4: the member's receipt for one of their (or their Junior's) bills — linked from the Payments tab. */
export default async function MemberReceiptPage({ params }: { params: Promise<{ billId: string }> }) {
  const actor = await requireUser(["MEMBER"]);
  const { billId } = await params;
  let data: Awaited<ReturnType<typeof myBillReceipt>>;
  try {
    data = await myBillReceipt(actor, billId);
  } catch (e) {
    if (isDomainError(e)) notFound();
    throw e;
  }
  const { bill, code, what } = data;
  const s = await getSettings();
  const lines = bill.lines.filter((l) => !l.voidedAt);
  const moved = bill.payments.filter((p) => p.status === "SUCCEEDED");
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="no-print flex w-full max-w-md items-center justify-between gap-2">
        <Link href="/portal/payments" className="text-sm font-semibold text-primary underline">← My payments</Link>
        <PrintButton />
      </div>
      <div className="receipt mx-auto font-mono text-[12px] leading-snug text-black" data-testid="member-receipt">
        <style>{`.receipt { width: 72mm; padding: 4mm; background: #fff; border: 1px dashed #999 } @media print { .receipt { border: 0 } @page { size: 80mm auto; margin: 0 } }`}</style>
        <div className="text-center">
          <p className="text-[14px] font-bold">{s.club.name || "Club"}</p>
          {s.club.address ? <p>{s.club.address}</p> : null}
          <p className="mt-1 font-bold">RECEIPT</p>
        </div>
        <p className="mt-2">{code ?? what} · {fmtDateTime(bill.createdAt)}</p>
        <p>{bill.customerName}</p>
        <hr className="my-1 border-dashed border-black" />
        {lines.map((l) => (
          <p key={l.id} className="flex justify-between"><span>{l.qty} × {l.description}</span><span>{formatINR(l.netAmount)}</span></p>
        ))}
        <hr className="my-1 border-dashed border-black" />
        <p className="flex justify-between font-bold"><span>TOTAL</span><span>{formatINR(bill.total)}</span></p>
        {moved.map((p) => (
          <p key={p.id} className="flex justify-between"><span>{p.type === "REFUND" ? "Refund" : "Paid"} {METHOD[p.method] ?? p.method} {fmtDateTime(p.occurredAt)}</span><span>{p.type === "REFUND" ? "-" : ""}{formatINR(p.amount)}</span></p>
        ))}
        <p className="flex justify-between font-bold"><span>NET PAID</span><span>{formatINR(bill.amountPaid - moved.filter((p) => p.type === "REFUND").reduce((a, p) => a + p.amount, 0))}</span></p>
      </div>
    </div>
  );
}
