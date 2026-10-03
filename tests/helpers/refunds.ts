// v3 §5.2: a discretionary refund is a request that someone else approves (RF-3); the desk then pays it out (RF-4).
import type { UserActor } from "@/server/rbac/actor";
import { approveRefund, requestRefund } from "@/server/services/refunds";
import type { RefundReason } from "@/server/services/refund-records";
import { prisma } from "@/server/db";
import type { World } from "./world";

/** Ask (default: the Manager) and approve (default: the Owner). Returns what is still waiting at the desk. */
export async function approvedRefund(
  w: World,
  billId: string,
  amount: number,
  opts: { by?: UserActor; approver?: UserActor; reason?: RefundReason; note?: string } = {},
) {
  const req = await requestRefund(opts.by ?? w.actors.MANAGER, { billId, amount, reason: opts.reason ?? "GOODWILL", note: opts.note ?? "goodwill" });
  const r = await approveRefund(opts.approver ?? w.actors.OWNER, req.id);
  const pending = (await prisma.payment.aggregate({ where: { refundRequestId: req.id, status: "PENDING" }, _sum: { amount: true } }))._sum.amount ?? 0;
  return { id: req.id, code: req.code, status: r.status, pending, refunded: amount - pending };
}
