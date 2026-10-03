import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/server/http";
import { handleWhatsappWebhook, verifyWhatsappWebhook } from "@/server/services/channels";

// v3 §6.3: Meta's WhatsApp Cloud API webhook. GET is the subscription handshake; POST carries delivery statuses,
// signed with the app secret over the exact raw body (X-Hub-Signature-256).
export async function GET(req: NextRequest) {
  try {
    return new NextResponse(verifyWhatsappWebhook(req.nextUrl.searchParams), { headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    return NextResponse.json({ data: await handleWhatsappWebhook(raw, req.headers.get("x-hub-signature-256")) });
  } catch (e) {
    return errorResponse(e);
  }
}
