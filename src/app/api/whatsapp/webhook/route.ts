import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/server/http";
import { handleWebhook, verifyWebhookSubscription } from "@/server/services/whatsapp/webhook";

// v4 §5.4 step 6: Meta's WhatsApp Cloud API webhook. GET is the subscription handshake (echo hub.challenge); POST
// carries delivery statuses and inbound messages, signed with the app secret over the exact raw body.
export async function GET(req: NextRequest) {
  try {
    const challenge = await verifyWebhookSubscription(req.nextUrl.searchParams);
    return new NextResponse(challenge, { headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    return NextResponse.json({ data: await handleWebhook(raw, req.headers.get("x-hub-signature-256")) });
  } catch (e) {
    return errorResponse(e);
  }
}
