import { z } from "zod";
import { body, route } from "@/server/http";
import { endRule } from "@/server/services/price-book";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => endRule(actor, params.id, (await body(req, z.object({ at: z.string().datetime({ offset: true }).optional() }))).at));
