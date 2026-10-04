import { route } from "@/server/http";
import { incomingOrders } from "@/server/services/member-orders";

// v5 MO-3: member orders waiting for the bar.
export const GET = route(async ({ actor }) => incomingOrders(actor));
