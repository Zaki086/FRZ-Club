import { body, route } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { createTrialBooking, trialSchema } from "@/server/services/crm";

export const POST = route(
  async ({ req }) => {
    rateLimit(`trial:ip:${clientIp(req)}`, 5, 10 * 60_000, "Too many trial requests from this device. Please try again in a few minutes.");
    return createTrialBooking(await body(req, trialSchema));
  },
  { auth: "optional" },
);
