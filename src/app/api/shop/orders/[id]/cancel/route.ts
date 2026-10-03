import { z } from "zod";
import { body, route } from "@/server/http";
import { cancelOrder } from "@/server/services/shop";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => cancelOrder(actor, params.id, (await body(req, z.object({ reason: z.string().min(3) }))).reason));
