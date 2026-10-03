import { body, route } from "@/server/http";
import { addVariant, newVariantSchema } from "@/server/services/products";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => addVariant(actor, params.id, await body(req, newVariantSchema)));
