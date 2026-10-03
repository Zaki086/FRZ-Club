import { body, route } from "@/server/http";
import { counterPaymentSchema, recordCounterPayment } from "@/server/services/payments";

export const POST = route(async ({ req, actor, idempotencyKey }) =>
  recordCounterPayment(actor, await body(req, counterPaymentSchema), idempotencyKey),
);
