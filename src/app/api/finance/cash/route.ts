import { z } from "zod";
import { query, route } from "@/server/http";
import { dailyCashReconciliation } from "@/server/services/drawers";

export const GET = route(async ({ req, actor }) => dailyCashReconciliation(actor, query(req, z.object({ date: z.string().optional() })).date));
