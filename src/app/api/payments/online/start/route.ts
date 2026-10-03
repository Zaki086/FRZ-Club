import { z } from "zod";
import { body, route } from "@/server/http";
import { startOnlinePayment } from "@/server/services/payments";

const schema = z.object({ billId: z.string().min(1), returnUrl: z.string().max(300).default("/") });

export const POST = route(async ({ req, actor, idempotencyKey }) => {
  const input = await body(req, schema);
  return startOnlinePayment(actor, input.billId, input.returnUrl, idempotencyKey);
});
