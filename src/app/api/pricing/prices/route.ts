import { body, route } from "@/server/http";
import { basePriceSchema, setBasePrice } from "@/server/services/price-book";

export const POST = route(async ({ req, actor }) => setBasePrice(actor, await body(req, basePriceSchema)));
