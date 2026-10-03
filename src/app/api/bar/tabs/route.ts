import { body, route } from "@/server/http";
import { listOpenTabs, openTab, openTabSchema } from "@/server/services/bar";

export const GET = route(async ({ actor }) => listOpenTabs(actor));

export const POST = route(async ({ req, actor, idempotencyKey }) => openTab(actor, await body(req, openTabSchema), idempotencyKey));
