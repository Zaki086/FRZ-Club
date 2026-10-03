import { body, route } from "@/server/http";
import { erasureSchema, myDataRequests, requestErasure } from "@/server/services/privacy";

export const GET = route(async ({ actor }) => myDataRequests(actor));
export const POST = route(async ({ req, actor }) => requestErasure(actor, await body(req, erasureSchema)));
