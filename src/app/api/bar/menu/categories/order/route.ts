import { body, route } from "@/server/http";
import { categoryOrderSchema, reorderMenuCategories } from "@/server/services/menu";

/** Drag to reorder: every category id, in the new display order. */
export const PUT = route(async ({ req, actor }) => reorderMenuCategories(actor, await body(req, categoryOrderSchema)));
