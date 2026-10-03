import { route } from "@/server/http";
import { approveDrawerVariance } from "@/server/services/drawers";

export const POST = route<{ id: string }>(async ({ actor, params }) => approveDrawerVariance(actor, params.id));
