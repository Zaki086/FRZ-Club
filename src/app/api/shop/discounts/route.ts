import { body, route } from "@/server/http";
import { addShopDiscount, listShopDiscounts, shopDiscountSchema } from "@/server/services/products";

/** D-79: category-wide / shop-wide discounts on shop products (shop staff within their limit). */
export const GET = route(async ({ actor }) => listShopDiscounts(actor));
export const POST = route(async ({ req, actor }) => addShopDiscount(actor, await body(req, shopDiscountSchema)));
