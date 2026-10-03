import { z } from "zod";
import { body, route } from "@/server/http";
import { updateMenuItem } from "@/server/services/bar";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) =>
  updateMenuItem(actor, params.id, await body(req, z.object({ available: z.boolean().optional(), price: z.number().int().min(0).optional() }))),
);
