import { z } from "zod";
import { body, route } from "@/server/http";
import { checkOut } from "@/server/services/checkin";

export const POST = route(async ({ req, actor }) => {
  const input = await body(req, z.object({ memberId: z.string().min(1), acknowledgeOpenTab: z.boolean().optional() }));
  return checkOut(actor, input.memberId, { acknowledgeOpenTab: input.acknowledgeOpenTab });
});
