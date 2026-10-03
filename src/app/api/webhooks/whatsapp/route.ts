// v3 address of the WhatsApp webhook, kept so a Meta app already pointed here keeps working. v4 §5.4: the handler
// lives at /api/whatsapp/webhook (set that URL in Meta's dashboard).
export { GET, POST } from "@/app/api/whatsapp/webhook/route";
