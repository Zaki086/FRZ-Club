import { body, route } from "@/server/http";
import { menuItemStatusSchema, setMenuItemStatus } from "@/server/services/menu";

/** DRAFT / ACTIVE / ARCHIVED (archive never deletes; restore returns it as a draft or straight to active). */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => setMenuItemStatus(actor, params.id, await body(req, menuItemStatusSchema)));
