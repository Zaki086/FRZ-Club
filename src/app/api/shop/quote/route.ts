import { z } from "zod";
import { body, route } from "@/server/http";
import { quoteCart } from "@/server/services/shop";

// PR-9 preview. Checkout and counter sales recompute every price on the server.
const schema = z.object({
  memberId: z.string().optional(),
  items: z.array(z.object({ variantId: z.string(), qty: z.number().int().positive() })).min(1),
  fulfilment: z.enum(["PICKUP", "DELIVERY"]).optional(),
});

export const POST = route(async ({ req, actor }) => quoteCart(actor, await body(req, schema)), { auth: "optional" });
