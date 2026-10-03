import { body, route } from "@/server/http";
import { downgradeSchema, scheduleDowngrade } from "@/server/services/membership";

export const POST = route(async ({ req, actor }) => scheduleDowngrade(actor, await body(req, downgradeSchema)));
