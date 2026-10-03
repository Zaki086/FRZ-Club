import { body, route } from "@/server/http";
import { returnItems, returnSchema } from "@/server/services/shop";

export const POST = route(async ({ req, actor }) => returnItems(actor, await body(req, returnSchema)));
