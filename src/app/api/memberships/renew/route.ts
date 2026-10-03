import { body, route } from "@/server/http";
import { renewMembership, renewSchema } from "@/server/services/membership";

export const POST = route(async ({ req, actor, idempotencyKey }) => renewMembership(actor, await body(req, renewSchema), idempotencyKey));
