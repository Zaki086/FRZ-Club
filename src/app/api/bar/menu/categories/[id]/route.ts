import { body, route } from "@/server/http";
import { categoryPatchSchema, updateMenuCategory } from "@/server/services/menu";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateMenuCategory(actor, params.id, await body(req, categoryPatchSchema)));
