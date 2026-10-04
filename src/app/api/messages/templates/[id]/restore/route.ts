// v5 §3.1 MT-3: bring an archived template back.
import { route } from "@/server/http";
import { restoreTemplate } from "@/server/services/messages/templates";

export const POST = route<{ id: string }>(async ({ actor, params }) => restoreTemplate(actor, params.id));
