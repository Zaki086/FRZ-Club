import { z } from "zod";
import { body, route } from "@/server/http";
import { moveTab } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => moveTab(actor, params.id, (await body(req, z.object({ tableId: z.string().nullable() }))).tableId));
