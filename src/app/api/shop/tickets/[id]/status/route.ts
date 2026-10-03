import { z } from "zod";
import { body, route } from "@/server/http";
import { setTicketStatus } from "@/server/services/shop";

const schema = z.object({ status: z.enum(["IN_PROGRESS", "READY", "COLLECTED"]) });

export const POST = route<{ id: string }>(async ({ req, actor, params }) => setTicketStatus(actor, params.id, (await body(req, schema)).status));
