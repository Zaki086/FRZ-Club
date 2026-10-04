import { body, route } from "@/server/http";
import { categoryInputSchema, createMenuCategory, listMenuCategories } from "@/server/services/menu";

export const GET = route(async ({ actor }) => listMenuCategories(actor));

export const POST = route(async ({ req, actor }) => createMenuCategory(actor, await body(req, categoryInputSchema)));
