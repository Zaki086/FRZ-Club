import { body, route } from "@/server/http";
import { memberRefundSchema, refundRequestSchema, requestRefund, requestRefundAsMember } from "@/server/services/refunds";

/** RF-1: staff ask with an amount and a reason category; members ask for an eligible item (all that is left, or part of it — RF-11). */
export const POST = route(async ({ req, actor, idempotencyKey }) => {
  if (actor.kind === "USER" && actor.role === "MEMBER") return requestRefundAsMember(actor, await body(req, memberRefundSchema));
  return requestRefund(actor, await body(req, refundRequestSchema), idempotencyKey);
});
