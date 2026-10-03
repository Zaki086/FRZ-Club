import { body, route } from "@/server/http";
import { updateVariant, variantUpdateSchema } from "@/server/services/shop";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateVariant(actor, params.id, await body(req, variantUpdateSchema)));
