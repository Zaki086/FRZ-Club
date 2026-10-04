// v5 §3.1 MT-3: archive (never delete).
import { route } from "@/server/http";
import { archiveTemplate } from "@/server/services/messages/templates";

export const POST = route<{ id: string }>(async ({ actor, params }) => archiveTemplate(actor, params.id));
