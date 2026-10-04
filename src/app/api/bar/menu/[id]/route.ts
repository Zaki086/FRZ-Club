import { body, route } from "@/server/http";
import { editMenuItem, menuItemDetail, menuItemPatchSchema } from "@/server/services/menu";

export const GET = route<{ id: string }>(async ({ actor, params }) => menuItemDetail(actor, params.id));

/** Edit, sold out / back on, or a new base price (MN-1: written to the price book). */
export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => editMenuItem(actor, params.id, await body(req, menuItemPatchSchema)));
