import { body, route } from "@/server/http";
import { changeRule, ruleSchema } from "@/server/services/price-book";

/** PR-12: a change ends this version and starts a new one. */
export const PUT = route<{ id: string }>(async ({ req, actor, params }) => changeRule(actor, params.id, await body(req, ruleSchema)));
