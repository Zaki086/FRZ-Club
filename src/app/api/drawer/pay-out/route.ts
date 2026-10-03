import { body, route } from "@/server/http";
import { payOut, payOutSchema } from "@/server/services/drawers";

export const POST = route(async ({ req, actor }) => payOut(actor, await body(req, payOutSchema)));
