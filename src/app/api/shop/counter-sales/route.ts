import { z } from "zod";
import { query, route } from "@/server/http";
import { listCounterSales } from "@/server/services/shop";

export const GET = route(async ({ req, actor }) => listCounterSales(actor, query(req, z.object({ date: z.string().optional() })).date));
