import { body, route } from "@/server/http";
import { purchaseMembership, purchaseSchema } from "@/server/services/membership";

export const POST = route(async ({ req, actor, idempotencyKey }) => purchaseMembership(actor, await body(req, purchaseSchema), idempotencyKey));
