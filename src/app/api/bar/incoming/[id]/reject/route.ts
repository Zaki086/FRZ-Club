import { body, route } from "@/server/http";
import { rejectMemberOrder, rejectOrderSchema } from "@/server/services/member-orders";

// v5 MO-3: reject with a reason → the member is told.
export const POST = route<{ id: string }>(async ({ req, actor, params }) => rejectMemberOrder(actor, params.id, await body(req, rejectOrderSchema)));
