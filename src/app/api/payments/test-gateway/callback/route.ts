import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/server/http";
import { isTestEnv } from "@/server/services/gateway";
import { verifyOnlinePayment } from "@/server/services/payments";

// The Test Gateway exists only under NODE_ENV=test (completion pass §2.1); everywhere else this is a 404.
const schema = z.object({ paymentId: z.string().min(1), gatewayPaymentId: z.string().min(1), outcome: z.enum(["SUCCESS", "FAIL"]), signature: z.string().min(1) });

export const POST = route(
  async ({ req }) => {
    if (!isTestEnv()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found.", details: null } }, { status: 404 });
    const { paymentId, ...payload } = await body(req, schema);
    return verifyOnlinePayment(paymentId, payload);
  },
  { auth: "optional" },
);
