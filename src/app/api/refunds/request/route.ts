import { z } from "zod";
import { body, route } from "@/server/http";
import { refundRequestSchema, requestRefund, requestRefundAsMember } from "@/server/services/refunds";

/** RF-1: staff ask with an amount and a reason category; members ask for an eligible item (the amount is what is left). */
export const POST = route(async ({ req, actor, idempotencyKey }) => {
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    return requestRefundAsMember(actor, await body(req, z.object({ billId: z.string().min(1), note: z.string().trim().max(300).optional() })));
  }
  return requestRefund(actor, await body(req, refundRequestSchema), idempotencyKey);
});
