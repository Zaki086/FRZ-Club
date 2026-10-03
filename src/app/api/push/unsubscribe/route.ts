import { z } from "zod";
import { body, route } from "@/server/http";
import { unsubscribePush } from "@/server/services/channels";

export const POST = route(async ({ req, actor }) => unsubscribePush(actor, (await body(req, z.object({ endpoint: z.string().max(1000) }))).endpoint));
