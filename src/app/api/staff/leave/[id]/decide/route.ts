import { z } from "zod";
import { body, route } from "@/server/http";
import { decideLeave } from "@/server/services/staff";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(300).optional() }));
  return decideLeave(actor, params.id, input.decision, input.note);
});
