import { body, route } from "@/server/http";
import { issueRefund, refundSchema } from "@/server/services/payments";

export const POST = route(async ({ req, actor, idempotencyKey }) => issueRefund(actor, await body(req, refundSchema), idempotencyKey));
