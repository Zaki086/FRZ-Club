import { route } from "@/server/http";
import { frontDeskToday } from "@/server/services/dashboards";

// v4 RN-5: the Front desk dashboard.
export const GET = route(async ({ actor }) => frontDeskToday(actor));
