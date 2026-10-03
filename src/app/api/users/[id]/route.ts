import { z } from "zod";
import { body, route } from "@/server/http";
import { setUserActive } from "@/server/services/users";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => setUserActive(actor, params.id, (await body(req, z.object({ active: z.boolean() }))).active));
