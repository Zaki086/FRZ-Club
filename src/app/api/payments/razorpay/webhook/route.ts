import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/server/http";
import { handleRazorpayWebhook } from "@/server/services/payments";

// §2.6a: Razorpay calls this server-to-server. The signature is checked over the exact raw body.
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const result = await handleRazorpayWebhook(raw, req.headers.get("x-razorpay-signature"));
    return NextResponse.json({ data: result });
  } catch (e) {
    return errorResponse(e);
  }
}
