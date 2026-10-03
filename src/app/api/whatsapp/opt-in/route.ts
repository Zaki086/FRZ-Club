import { body, route } from "@/server/http";
import { myWhatsappOptIn, setMyWhatsappOptIn, whatsappOptInSchema } from "@/server/services/whatsapp/opt-in";

// v4 §5.1: a member's own consent to automatic WhatsApp updates (portal → Notifications).
export const GET = route(async ({ actor }) => myWhatsappOptIn(actor));
export const POST = route(async ({ req, actor }) => setMyWhatsappOptIn(actor, await body(req, whatsappOptInSchema)));
