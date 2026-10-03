import { body, route } from "@/server/http";
import { listStockTakes, postStockTake, stockTakeSchema } from "@/server/services/purchasing";

export const GET = route(async ({ actor }) => listStockTakes(actor));
export const POST = route(async ({ req, actor }) => postStockTake(actor, await body(req, stockTakeSchema)));
