import { body, route } from "@/server/http";
import { refundRequestSchema, requestRefund } from "@/server/services/refunds";

/** v3 RF-6: asking for a refund opens a request (it no longer pays out directly). */
export const POST = route(async ({ req, actor, idempotencyKey }) => requestRefund(actor, await body(req, refundRequestSchema), idempotencyKey));
