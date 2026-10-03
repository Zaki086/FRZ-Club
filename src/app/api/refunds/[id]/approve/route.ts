import { z } from "zod";
import { body, route } from "@/server/http";
import { approveRefund } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.object({ note: z.string().trim().max(300).optional() }));
  return approveRefund(actor, params.id, input.note || undefined);
});
