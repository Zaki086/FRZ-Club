import { z } from "zod";
import { body, route } from "@/server/http";
import { assignLead } from "@/server/services/crm";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => assignLead(actor, params.id, (await body(req, z.object({ userId: z.string() }))).userId));
