import { body, route } from "@/server/http";
import { settleSchema, settleTab } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params, idempotencyKey }) => settleTab(actor, params.id, await body(req, settleSchema), idempotencyKey));
