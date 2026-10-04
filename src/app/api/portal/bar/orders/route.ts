import { cookies } from "next/headers";
import { body, route } from "@/server/http";
import { SESSION_COOKIE } from "@/server/auth/sessions";
import { memberOrderSchema, placeMemberOrder } from "@/server/services/member-orders";

// v5 MO-1…MO-6: place an order from the cart (prices re-quoted by the server; Idempotency-Key places it once).
export const POST = route(async ({ req, actor, idempotencyKey }) =>
  placeMemberOrder(actor, await body(req, memberOrderSchema), { sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, idempotencyKey }),
);
