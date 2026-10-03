import { z } from "zod";
import { body, route } from "@/server/http";
import { verifyOnlinePayment } from "@/server/services/payments";

const schema = z.object({
  paymentId: z.string().min(1),
  outcome: z.enum(["SUCCESS", "FAIL"]).default("SUCCESS"),
  razorpay_payment_id: z.string().optional(),
  razorpay_order_id: z.string().optional(),
  razorpay_signature: z.string().optional(),
});

export const POST = route(
  async ({ req }) => {
    const { paymentId, ...rest } = await body(req, schema);
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) if (v) payload[k] = v;
    return verifyOnlinePayment(paymentId, payload);
  },
  { auth: "optional" },
);
