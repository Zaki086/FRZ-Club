// v5 §3.2: one-click unsubscribe from announcement emails (public, signed token). Mail clients POST here with
// `List-Unsubscribe=One-Click` and the token in `?t=` (RFC 8058); the unsubscribe page posts JSON { token, resubscribe }.
import { route } from "@/server/http";
import { unsubscribeSchema } from "@/server/services/messages/schemas";
import { applyUnsubscribe } from "@/server/services/messages/unsubscribe";

export const POST = route(async ({ req }) => {
  const fromQuery = req.nextUrl.searchParams.get("t");
  let json: unknown = {};
  if ((req.headers.get("content-type") ?? "").includes("application/json")) json = await req.json().catch(() => ({}));
  const input = unsubscribeSchema.parse({ ...(json as object), ...(fromQuery ? { token: fromQuery } : {}) });
  return applyUnsubscribe(input.token, { resubscribe: input.resubscribe ?? false });
}, { auth: "optional" });
