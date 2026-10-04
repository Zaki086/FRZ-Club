import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { isDomainError } from "@/server/errors";
import { can } from "@/server/rbac/permissions";
import { getRefundRequest } from "@/server/services/refunds";
import { getSettings } from "@/server/services/settings";
import { PageHeader } from "@/components/page";
import { RefundDetail } from "./refund-detail";

export const metadata: Metadata = { title: "Refund" };

/** v4 §3.3: the refund page approvers are sent to (approvals panel, REFUND_APPROVAL_NEEDED), and the desk's pay-out. */
export default async function RefundPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!(["refunds.request", "refunds.approve", "invoices"] as const).some((c) => can(actor, c))) forbidden();
  const { id } = await params;
  let r: Awaited<ReturnType<typeof getRefundRequest>>;
  try {
    r = await getRefundRequest(actor, id);
  } catch (e) {
    if (isDomainError(e, "NOT_FOUND")) notFound();
    if (isDomainError(e, "FORBIDDEN")) forbidden();
    throw e;
  }
  const s = await getSettings();
  return (
    <div>
      <PageHeader title={`Refund ${r.code}`} meta={`${r.customer} · ${r.what}`} />
      <RefundDetail
        id={r.id}
        me={actor.userId}
        canApprove={can(actor, "refunds.approve")}
        isOwner={actor.role === "OWNER"}
        managerLimit={s.refund_manager_limit}
        canMessage={can(actor, "messages.compose")}
      />
    </div>
  );
}
