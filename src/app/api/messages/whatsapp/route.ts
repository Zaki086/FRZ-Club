import { body, route } from "@/server/http";
import { whatsappLink, whatsappSchema } from "@/server/services/messages";

export const POST = route(async ({ req, actor }) => whatsappLink(actor, await body(req, whatsappSchema)));
