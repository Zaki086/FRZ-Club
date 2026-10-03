import { body, route } from "@/server/http";
import { createProduct, productSchema } from "@/server/services/shop";

export const POST = route(async ({ req, actor }) => createProduct(actor, await body(req, productSchema)));
