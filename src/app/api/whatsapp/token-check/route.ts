import { route } from "@/server/http";
import { checkWhatsappToken } from "@/server/services/whatsapp/setup";

export const POST = route(async ({ actor }) => checkWhatsappToken(actor));
