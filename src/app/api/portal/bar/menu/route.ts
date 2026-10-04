import { z } from "zod";
import { query, route } from "@/server/http";
import { memberMenu } from "@/server/services/member-orders";

// v5 §1.2: the menu with this member's prices (alcohol hidden for Juniors / under-18, MO-6).
export const GET = route(async ({ req, actor }) => memberMenu(actor, { forMemberId: query(req, z.object({ for: z.string().min(1).optional() })).for }));
