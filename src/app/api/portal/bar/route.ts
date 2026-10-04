import { cookies } from "next/headers";
import { z } from "zod";
import { query, route } from "@/server/http";
import { SESSION_COOKIE } from "@/server/auth/sessions";
import { myBar } from "@/server/services/member-orders";

// v5 §1.2 "My tab" + whether ordering is possible now (MO-1 reads this login's table scan).
export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ for: z.string().min(1).optional() }));
  return myBar(actor, { forMemberId: q.for, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value });
});
