import { body, route } from "@/server/http";
import { forgotPassword, forgotSchema } from "@/server/auth/account";
import { clientIp, rateLimit } from "@/server/rate-limit";

export const POST = route(
  async ({ req }) => {
    const input = await body(req, forgotSchema);
    rateLimit(`forgot:ip:${clientIp(req)}`, 10, 60 * 60_000, "Too many reset requests from this device. Please try again later.");
    rateLimit(`forgot:id:${input.identifier.toLowerCase()}`, 3, 60 * 60_000, "A reset link was already requested for this account. Please wait before asking again.");
    return forgotPassword(input);
  },
  { auth: "optional" },
);
