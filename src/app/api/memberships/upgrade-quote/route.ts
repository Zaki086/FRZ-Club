import { body, route } from "@/server/http";
import { quoteUpgrade, upgradeSchema } from "@/server/services/membership";

export const POST = route(async ({ req, actor }) => quoteUpgrade(actor, await body(req, upgradeSchema)));
