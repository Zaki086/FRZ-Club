import { route } from "@/server/http";
import { listPlans } from "@/server/services/plans";

export const GET = route(async () => listPlans({ activeOnly: true }), { auth: "optional" });
