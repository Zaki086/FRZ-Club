import { z } from "zod";
import { body, route } from "@/server/http";
import { cancelSocialSession } from "@/server/services/social";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.object({ reason: z.string().min(3) }));
  return cancelSocialSession(actor, params.id, input.reason);
});
