import { z } from "zod";
import { body, route } from "@/server/http";
import { redeemPasswordSetToken } from "@/server/auth/sessions";

export const POST = route(
  async ({ req }) => {
    const input = await body(req, z.object({ token: z.string().min(10), password: z.string().min(8).max(100) }));
    await redeemPasswordSetToken(input.token, input.password);
    return { ok: true };
  },
  { auth: "optional" },
);
