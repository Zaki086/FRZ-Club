import { body, route } from "@/server/http";
import { sendWhatsappTestMessage, whatsappTestMessageSchema } from "@/server/services/whatsapp/setup";

export const POST = route(async ({ req, actor }) => sendWhatsappTestMessage(actor, await body(req, whatsappTestMessageSchema)));
