import { body, route } from "@/server/http";
import { sendWhatsappTest, whatsappTestSchema } from "@/server/services/channels";

export const POST = route(async ({ req, actor }) => sendWhatsappTest(actor, await body(req, whatsappTestSchema)));
