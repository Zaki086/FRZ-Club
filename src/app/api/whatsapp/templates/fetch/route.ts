import { route } from "@/server/http";
import { fetchWhatsappTemplates } from "@/server/services/whatsapp/setup";

// v4 §5.1 "Fetch templates": Meta's status for every mapped template (GET /{WABA_ID}/message_templates).
export const POST = route(async ({ actor }) => fetchWhatsappTemplates(actor));
