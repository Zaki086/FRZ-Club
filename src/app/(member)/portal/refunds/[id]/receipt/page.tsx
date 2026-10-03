import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { isDomainError } from "@/server/errors";
import { refundReceipt } from "@/server/services/refunds";
import { RefundReceipt } from "@/components/refund-receipt";
import { PrintButton } from "@/components/print-button";

export const metadata: Metadata = { title: "Refund receipt" };

/** v4 §3.4: the member's copy of the refund receipt (their own or their Junior's refund), to print or save as PDF. */
export default async function MemberRefundReceipt({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser(["MEMBER"]);
  const { id } = await params;
  let r: Awaited<ReturnType<typeof refundReceipt>>;
  try {
    r = await refundReceipt(actor, id);
  } catch (e) {
    if (isDomainError(e)) notFound(); // not theirs, or not paid out yet
    throw e;
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="no-print flex w-full max-w-md items-center justify-between gap-2">
        <Link href="/portal/refunds" className="text-sm font-semibold text-primary underline">← My refunds</Link>
        <PrintButton />
      </div>
      <RefundReceipt r={r} />
    </div>
  );
}
