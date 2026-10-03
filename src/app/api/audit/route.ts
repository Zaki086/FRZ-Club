import { z } from "zod";
import { query, route } from "@/server/http";
import { listAudit } from "@/server/services/audit";

export const GET = route(async ({ req, actor }) =>
  listAudit(actor, query(req, z.object({ entity: z.string().optional(), entityId: z.string().optional(), action: z.string().optional(), search: z.string().optional(), before: z.string().optional(), limit: z.coerce.number().optional() }))),
);
