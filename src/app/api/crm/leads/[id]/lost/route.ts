import { z } from "zod";
import { body, route } from "@/server/http";
import { markLost } from "@/server/services/crm";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => markLost(actor, params.id, (await body(req, z.object({ reason: z.string() }))).reason));
