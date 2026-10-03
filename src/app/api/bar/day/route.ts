import { z } from "zod";
import { query, route } from "@/server/http";
import { barDayReport } from "@/server/services/bar";

export const GET = route(async ({ req, actor }) => barDayReport(actor, query(req, z.object({ date: z.string() })).date));
