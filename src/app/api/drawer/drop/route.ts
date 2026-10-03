import { body, route } from "@/server/http";
import { cashDrop, cashDropSchema } from "@/server/services/drawers";

export const POST = route(async ({ req, actor }) => cashDrop(actor, await body(req, cashDropSchema)));
