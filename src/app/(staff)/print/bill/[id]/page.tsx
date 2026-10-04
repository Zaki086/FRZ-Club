import type { Metadata } from "next";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { getBill } from "@/server/services/payments";
import { getSettings } from "@/server/services/settings";
import { prisma } from "@/server/db";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { PrintNow } from "./print-now";
import { formatPhone } from "@/lib/validation/contact";

export const metadata: Metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

const METHOD: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK_TRANSFER: "Bank transfer", ONLINE: "Online" };

/** Completion pass P1: an 80 mm thermal receipt / bar bill for any bill the staff member may see. */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser(STAFF_ROLES);
  const { id } = await params;
  const bill = await getBill(actor, id);
  const s = await getSettings();
  const ref =
    bill.sourceType === "COUNTER_SALE" ? (await prisma.counterSale.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code
    : bill.sourceType === "BAR_TAB" ? (await prisma.tab.findFirst({ where: { billId: bill.id }, select: { code: true } }))?.code
    : bill.sourceType === "BOOKING" ? (await prisma.booking.findFirst({ where: { billId: bill.id }, select: { bookingCode: true } }))?.bookingCode
    : null;
  const lines = bill.lines.filter((l) => !l.voidedAt);
  const paid = bill.payments.filter((p) => p.status === "SUCCEEDED");
  const change = paid.reduce((a, p) => a + (p.changeGiven ?? 0), 0);
  return (
    <div className="receipt mx-auto font-mono text-[12px] leading-snug text-black">
      <style>{`@page { size: 80mm auto; margin: 0 } .receipt { width: 72mm; padding: 4mm 0 } @media screen { .receipt { margin-top: 1rem; padding: 4mm; border: 1px dashed #999 } }`}</style>
      <div className="text-center">
        <p className="text-[14px] font-bold">{s.club.name || "Club"}</p>
        {s.club.address ? <p>{s.club.address}</p> : null}
        {s.club.phone ? <p>{formatPhone(s.club.phone)}</p> : null}
        {s.gstEnabled ? <p>GSTIN {s.club.gstin}</p> : null}
        <p className="mt-1 font-bold">{s.gstEnabled ? "TAX INVOICE" : "RECEIPT"}</p>
      </div>
      <p className="mt-2">{ref ?? bill.id.slice(-8).toUpperCase()} · {fmtDateTime(bill.createdAt)}</p>
      <p>{bill.customerName}</p>
      <hr className="my-1 border-dashed border-black" />
      {lines.map((l) => (
        <div key={l.id}>
          <p>{l.qty} × {l.description}</p>
          <p className="flex justify-between"><span>{l.discountAmount ? `  less ${formatINR(l.discountAmount)}` : ""}</span><span>{formatINR(l.netAmount)}</span></p>
        </div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      <p className="flex justify-between font-bold"><span>TOTAL</span><span>{formatINR(bill.total)}</span></p>
      {s.gstEnabled && bill.taxTotal ? <p className="flex justify-between"><span>incl. GST</span><span>{formatINR(bill.taxTotal)}</span></p> : null}
      {bill.discountTotal ? <p className="flex justify-between"><span>You saved</span><span>{formatINR(bill.discountTotal)}</span></p> : null}
      {paid.map((p) => (
        <p key={p.id} className="flex justify-between"><span>{p.type === "REFUND" ? "Refund" : "Paid"} {METHOD[p.method] ?? p.method}{p.reference && p.method === "UPI" ? ` …${p.reference.slice(-4)}` : ""}</span><span>{p.type === "REFUND" ? "-" : ""}{formatINR(p.amount)}</span></p>
      ))}
      {change ? <p className="flex justify-between"><span>Change</span><span>{formatINR(change)}</span></p> : null}
      {bill.due > 0 ? <p className="flex justify-between font-bold"><span>DUE</span><span>{formatINR(bill.due)}</span></p> : null}
      <hr className="my-1 border-dashed border-black" />
      <p className="text-center">Thank you!</p>
      <PrintNow />
    </div>
  );
}
