import { z } from "zod";
import { body, query, route } from "@/server/http";
import { assignShift, listRoster, shiftSchema } from "@/server/services/staff";

export const GET = route(async ({ req, actor }) => listRoster(actor, query(req, z.object({ from: z.string().optional(), days: z.coerce.number().optional() }))));

export const POST = route(async ({ req, actor }) => assignShift(actor, await body(req, shiftSchema)));
