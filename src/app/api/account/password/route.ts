import { cookies } from "next/headers";
import { body, route } from "@/server/http";
import { changePassword, changePasswordSchema } from "@/server/auth/account";
import { SESSION_COOKIE } from "@/server/auth/sessions";
import { rateLimit } from "@/server/rate-limit";

export const POST = route(async ({ req, actor }) => {
  if (actor.kind === "USER") rateLimit(`password:${actor.userId}`, 10, 15 * 60_000);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return changePassword(actor, token, await body(req, changePasswordSchema));
});
