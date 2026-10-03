import { route } from "@/server/http";
import { drawersOverview } from "@/server/services/drawers";

// Owner "Cash Drawers": every till with its live balance, the safe and approvals waiting.
export const GET = route(async ({ actor }) => drawersOverview(actor));
