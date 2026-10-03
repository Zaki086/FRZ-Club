import { z } from "zod";
import { body, route } from "@/server/http";
import { setExpenseAttachment } from "@/server/services/expenses";

export const PUT = route<{ id: string }>(async ({ req, actor, params }) => setExpenseAttachment(actor, params.id, (await body(req, z.object({ url: z.string() }))).url));
