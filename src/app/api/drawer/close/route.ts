import { body, route } from "@/server/http";
import { closeDrawer, closeDrawerSchema } from "@/server/services/drawers";

export const POST = route(async ({ req, actor }) => closeDrawer(actor, await body(req, closeDrawerSchema)));
