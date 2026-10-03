import { body, route } from "@/server/http";
import { checkout, checkoutSchema } from "@/server/services/shop";

export const POST = route(async ({ req, actor, idempotencyKey }) => checkout(actor, await body(req, checkoutSchema), idempotencyKey), { auth: "optional" });
