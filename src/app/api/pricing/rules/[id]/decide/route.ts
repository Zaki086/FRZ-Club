import { z } from "zod";
import { body, route } from "@/server/http";
import { decideRule } from "@/server/services/price-book";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => decideRule(actor, params.id, (await body(req, z.object({ decision: z.enum(["APPROVE", "REJECT"]) }))).decision));
