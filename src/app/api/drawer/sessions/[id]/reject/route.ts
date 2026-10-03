import { z } from "zod";
import { body, route } from "@/server/http";
import { rejectDrawerVariance } from "@/server/services/drawers";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => rejectDrawerVariance(actor, params.id, (await body(req, z.object({ reason: z.string() }))).reason));
