import { body, route } from "@/server/http";
import { productDetail, productDetailsSchema, updateProductDetails } from "@/server/services/products";

export const GET = route<{ id: string }>(async ({ actor, params }) => productDetail(actor, params.id));
export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateProductDetails(actor, params.id, await body(req, productDetailsSchema)));
