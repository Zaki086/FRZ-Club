import { z } from "zod";
import { body, route } from "@/server/http";
import { closeBarDay } from "@/server/services/bar";

export const POST = route(async ({ req, actor }) => closeBarDay(actor, (await body(req, z.object({ date: z.string() }))).date));
