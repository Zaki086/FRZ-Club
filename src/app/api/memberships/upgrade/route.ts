import { body, route } from "@/server/http";
import { upgradeMembership, upgradeSchema } from "@/server/services/membership";

export const POST = route(async ({ req, actor, idempotencyKey }) => upgradeMembership(actor, await body(req, upgradeSchema), idempotencyKey));
