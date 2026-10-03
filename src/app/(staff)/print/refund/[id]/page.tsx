import type { Metadata } from "next";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { refundReceipt } from "@/server/services/refunds";
import { RefundReceipt } from "@/components/refund-receipt";
import { PrintNow } from "../../bill/[id]/print-now";

export const metadata: Metadata = { title: "Refund receipt" };
export const dynamic = "force-dynamic";

/** v4 RF-9: the 80 mm refund receipt printed at the desk after a pay-out (staff who may see the refund). */
export default async function RefundReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser(STAFF_ROLES);
  const { id } = await params;
  const r = await refundReceipt(actor, id);
  return (
    <RefundReceipt r={r}>
      <PrintNow />
    </RefundReceipt>
  );
}
