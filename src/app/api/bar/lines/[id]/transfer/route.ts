import { z } from "zod";
import { body, route } from "@/server/http";
import { transferLine } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => transferLine(actor, params.id, (await body(req, z.object({ toTabId: z.string().min(1) }))).toTabId));
