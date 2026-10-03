import { z } from "zod";
import { body, route } from "@/server/http";
import { voidLine } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => voidLine(actor, params.id, (await body(req, z.object({ reason: z.string().default("") }))).reason));
