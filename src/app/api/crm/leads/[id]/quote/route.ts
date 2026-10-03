import { body, route } from "@/server/http";
import { createQuote, quoteSchema } from "@/server/services/crm";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => createQuote(actor, params.id, await body(req, quoteSchema)));
