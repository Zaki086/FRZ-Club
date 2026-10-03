import { route } from "@/server/http";
import { kitchenQueue } from "@/server/services/bar";

export const GET = route(async ({ actor }) => kitchenQueue(actor));
