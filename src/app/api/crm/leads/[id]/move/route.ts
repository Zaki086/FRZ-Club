import { body, route } from "@/server/http";
import { moveLead, moveSchema } from "@/server/services/crm";

/** v6 §3: a leads board column move (drag & drop or "Move to…"); the rules live in the service. */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => moveLead(actor, params.id, await body(req, moveSchema)));
