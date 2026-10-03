import { z } from "zod";
import { body, route } from "@/server/http";
import { leaveSession } from "@/server/services/social";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.object({ refundMethod: z.enum(["CASH", "CARD", "UPI"]).optional() }));
  return leaveSession(actor, params.id, input.refundMethod);
});
