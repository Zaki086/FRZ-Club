import { route } from "@/server/http";
import { ownerCash } from "@/server/services/dashboards";

// v4 RN-5: the Owner's cash summary card.
export const GET = route(async ({ actor }) => ownerCash(actor));
