import { body, route } from "@/server/http";
import { addProductPromotion, productPromotionSchema } from "@/server/services/products";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => addProductPromotion(actor, params.id, await body(req, productPromotionSchema)));
