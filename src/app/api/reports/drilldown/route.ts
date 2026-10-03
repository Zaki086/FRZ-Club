import { z } from "zod";
import { query, route } from "@/server/http";
import { drillDown, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, periodSchema.extend({ metric: z.string().min(3) }));
  return drillDown(actor, q.metric, q);
});
