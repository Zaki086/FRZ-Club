import { z } from "zod";
import { query, route } from "@/server/http";
import { listLedger, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => listLedger(actor, query(req, periodSchema.extend({ source: z.string().optional(), method: z.string().optional() }))));
