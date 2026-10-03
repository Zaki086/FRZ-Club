import { route } from "@/server/http";
import { markManualSent } from "@/server/services/channels";

export const POST = route<{ id: string }>(async ({ actor, params }) => markManualSent(actor, params.id));
