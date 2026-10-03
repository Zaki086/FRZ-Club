import { route } from "@/server/http";
import { whatsappSetupStatus } from "@/server/services/whatsapp/setup";

// v4 §5.1 Settings → WhatsApp: env present / token valid / webhook verified / test message, and the template table.
export const GET = route(async ({ actor }) => whatsappSetupStatus(actor));
