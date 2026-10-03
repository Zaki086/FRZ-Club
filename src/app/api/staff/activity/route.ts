import { z } from "zod";
import { query, route } from "@/server/http";
import { listStaffActivity } from "@/server/services/audit";

export const GET = route(async ({ req, actor }) => listStaffActivity(actor, query(req, z.object({ date: z.string().optional(), userId: z.string().optional() }))));
