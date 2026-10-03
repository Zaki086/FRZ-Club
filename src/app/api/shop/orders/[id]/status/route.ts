import { z } from "zod";
import { body, route } from "@/server/http";
import { setOrderStatus } from "@/server/services/shop";

const schema = z.object({ status: z.enum(["READY_FOR_PICKUP", "COLLECTED", "PACKED", "OUT_FOR_DELIVERY", "DELIVERED"]) });

export const POST = route<{ id: string }>(async ({ req, actor, params }) => setOrderStatus(actor, params.id, (await body(req, schema)).status));
