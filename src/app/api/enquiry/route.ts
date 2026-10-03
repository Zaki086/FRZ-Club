import { body, route } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { createEnquiry, leadSchema, publicFormSchema } from "@/server/services/crm";

export const POST = route(
  async ({ req }) => {
    rateLimit(`enquiry:ip:${clientIp(req)}`, 5, 10 * 60_000, "Too many enquiries from this device. Please try again in a few minutes.");
    return createEnquiry(await body(req, leadSchema.extend(publicFormSchema.shape)));
  },
  { auth: "optional" },
);
