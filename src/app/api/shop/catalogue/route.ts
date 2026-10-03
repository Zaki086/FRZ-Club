import { z } from "zod";
import { query, route } from "@/server/http";
import { listCatalogue } from "@/server/services/shop";

export const GET = route(async ({ req }) => listCatalogue(query(req, z.object({ category: z.string().optional(), q: z.string().optional() }))), { auth: "optional" });
