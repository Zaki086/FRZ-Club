import { z } from "zod";
import { body, route } from "@/server/http";
import { verifyOnlinePayment } from "@/server/services/payments";

// PY-7: the Test Gateway page posts its signed outcome here — the same verification path as Razorpay.
const schema = z.object({
  paymentId: z.string().min(1),
  gatewayPaymentId: z.string().min(1),
  outcome: z.enum(["SUCCESS", "FAIL"]),
  signature: z.string().min(1),
});

export const POST = route(
  async ({ req }) => {
    const { paymentId, ...payload } = await body(req, schema);
    return verifyOnlinePayment(paymentId, payload);
  },
  { auth: "optional" },
);
