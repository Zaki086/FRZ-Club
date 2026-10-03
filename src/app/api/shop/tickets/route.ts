import { z } from "zod";
import { query, route } from "@/server/http";
import { listTickets } from "@/server/services/shop";

export const GET = route(async ({ req, actor }) => listTickets(actor, { open: query(req, z.object({ open: z.string().optional() })).open === "1" }));
