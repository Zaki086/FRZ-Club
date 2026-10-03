import { body, route } from "@/server/http";
import { tillUpdateSchema, updateTill } from "@/server/services/drawers";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateTill(actor, params.id, await body(req, tillUpdateSchema)));
