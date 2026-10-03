import { body, route } from "@/server/http";
import { saveTemplateMapping, templateMappingSchema } from "@/server/services/whatsapp/setup";

// v4 §5.1: event template → WhatsApp Manager template name + language code.
export const PUT = route(async ({ req, actor }) => saveTemplateMapping(actor, await body(req, templateMappingSchema)));
