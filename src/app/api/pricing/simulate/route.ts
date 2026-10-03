import { body, route } from "@/server/http";
import { simulatePrice, simulateSchema } from "@/server/services/price-book";

/** PR-13: the final price with its explanation, from the real engine. */
export const POST = route(async ({ req, actor }) => simulatePrice(actor, await body(req, simulateSchema)));
