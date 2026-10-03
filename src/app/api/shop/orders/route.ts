import { z } from "zod";
import { query, route } from "@/server/http";
import { listOrders } from "@/server/services/shop";

export const GET = route(async ({ req, actor }) => listOrders(actor, query(req, z.object({ status: z.string().optional() }))));
