import { body, route } from "@/server/http";
import { createRule, ruleSchema } from "@/server/services/price-book";

export const POST = route(async ({ req, actor }) => createRule(actor, await body(req, ruleSchema)));
