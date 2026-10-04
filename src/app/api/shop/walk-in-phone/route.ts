import { z } from "zod";
import { query, route } from "@/server/http";
import { walkInPhoneMembers } from "@/server/services/shop";

/** v6 WI-3: the members a walk-in phone belongs to (the POS asks "use member pricing?" — never applied silently). */
export const GET = route(async ({ req, actor }) => walkInPhoneMembers(actor, query(req, z.object({ phone: z.string().max(25) })).phone));
