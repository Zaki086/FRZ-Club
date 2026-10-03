import { z } from "zod";
import { body, route } from "@/server/http";
import { cancelPurchaseOrder, markOrdered, receivePurchaseOrder } from "@/server/services/purchasing";

const schema = z.object({ action: z.enum(["order", "receive", "cancel"]), reason: z.string().optional() });

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, schema);
  if (input.action === "order") return markOrdered(actor, params.id);
  if (input.action === "receive") return receivePurchaseOrder(actor, params.id);
  return cancelPurchaseOrder(actor, params.id, input.reason ?? "");
});
