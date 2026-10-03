import { route } from "@/server/http";
import { getDrawerSession } from "@/server/services/drawers";

export const GET = route<{ id: string }>(async ({ actor, params }) => getDrawerSession(actor, params.id));
