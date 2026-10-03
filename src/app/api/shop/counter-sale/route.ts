import { body, route } from "@/server/http";
import { counterSale, counterSaleSchema } from "@/server/services/shop";

export const POST = route(async ({ req, actor, idempotencyKey }) => counterSale(actor, await body(req, counterSaleSchema), idempotencyKey));
