import { route } from "@/server/http";
import { endShopDiscount } from "@/server/services/products";

/** End a shop discount now (it stays in the price book, ended). */
export const POST = route<{ id: string }>(async ({ actor, params }) => endShopDiscount(actor, params.id));
