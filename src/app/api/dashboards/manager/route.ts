import { route } from "@/server/http";
import { managerToday } from "@/server/services/dashboards";

// v4 RN-5: the Manager's "Today's operations".
export const GET = route(async ({ actor }) => managerToday(actor));
