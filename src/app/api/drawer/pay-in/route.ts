import { body, route } from "@/server/http";
import { payIn, payInSchema } from "@/server/services/drawers";

export const POST = route(async ({ req, actor }) => payIn(actor, await body(req, payInSchema)));
