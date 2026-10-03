import { z } from "zod";
import { body, route } from "@/server/http";
import { lookupByCard } from "@/server/services/members";

export const POST = route(async ({ req, actor }) => lookupByCard(actor, (await body(req, z.object({ payload: z.string().min(1).max(200) }))).payload));
