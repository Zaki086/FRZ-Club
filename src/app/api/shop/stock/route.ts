import { z } from "zod";
import { query, route } from "@/server/http";
import { listStock } from "@/server/services/inventory";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ low: z.string().optional(), q: z.string().optional() }));
  return listStock(actor, { lowOnly: q.low === "1", q: q.q });
});
