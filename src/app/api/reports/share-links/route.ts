import { z } from "zod";
import { body, route } from "@/server/http";
import { createShareLink, listShareLinks, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ actor }) => listShareLinks(actor));

export const POST = route(async ({ req, actor }) => createShareLink(actor, await body(req, periodSchema.extend({ days: z.number().int().min(1).max(90).optional() }))));
