import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createSessionSchema, createSocialSession, listSocialSessions } from "@/server/services/social";

export const GET = route(
  async ({ req, actor }) => {
    const q = query(req, z.object({ from: z.string().optional(), days: z.coerce.number().optional() }));
    return listSocialSessions(actor, q);
  },
  { auth: "optional" },
);

export const POST = route(async ({ req, actor }) => createSocialSession(actor, await body(req, createSessionSchema)));
