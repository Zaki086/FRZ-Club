import { z } from "zod";
import { body, route } from "@/server/http";
import { assignLead } from "@/server/services/crm";

/** v3 LA-7: Manager/Owner reassign with a reason. */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.object({ userId: z.string(), reason: z.string() }));
  return assignLead(actor, params.id, input.userId, input.reason);
});
