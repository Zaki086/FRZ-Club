import { z } from "zod";
import { body, route } from "@/server/http";
import { setGuardrails } from "@/server/services/price-book";

/** PR-11: Owner only (the settings capability). */
export const PUT = route(async ({ req, actor }) => setGuardrails(actor, await body(req, z.object({ maxManagerDiscountPct: z.number().int().min(0).max(100).optional(), maxStaffDiscountPct: z.number().int().min(0).max(100).optional() }))));
