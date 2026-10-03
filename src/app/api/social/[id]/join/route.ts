import { z } from "zod";
import { body, route } from "@/server/http";
import { joinSession } from "@/server/services/social";
import { paymentChoiceSchema, playerInputSchema } from "@/server/services/booking";

const schema = z.object({ player: playerInputSchema, payment: paymentChoiceSchema.optional() });

export const POST = route<{ id: string }>(async ({ req, actor, params, idempotencyKey }) => {
  const input = await body(req, schema);
  return joinSession(actor, { sessionId: params.id, player: input.player, payment: input.payment }, idempotencyKey);
});
