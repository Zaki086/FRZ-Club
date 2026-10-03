import { body, route } from "@/server/http";
import { adjustSchema, adjustStock } from "@/server/services/inventory";

export const POST = route(async ({ req, actor }) => adjustStock(actor, await body(req, adjustSchema)));
