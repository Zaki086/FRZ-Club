import { route } from "@/server/http";
import { openManualMessage } from "@/server/services/channels";

export const POST = route<{ id: string }>(async ({ actor, params }) => openManualMessage(actor, params.id));
