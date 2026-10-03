import { z } from "zod";
import { body, route } from "@/server/http";
import { setCourtActive } from "@/server/services/courts";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => setCourtActive(actor, params.id, (await body(req, z.object({ active: z.boolean() }))).active));
