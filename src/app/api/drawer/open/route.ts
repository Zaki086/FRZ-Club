import { body, route } from "@/server/http";
import { openDrawer, openDrawerSchema } from "@/server/services/drawers";

export const POST = route(async ({ req, actor }) => openDrawer(actor, await body(req, openDrawerSchema)));
