import { body, route } from "@/server/http";
import { acceptMemberOrder, acceptOrderSchema } from "@/server/services/member-orders";

// v5 MO-3: accept (optionally set the table) → the order's lines go to the kitchen.
export const POST = route<{ id: string }>(async ({ req, actor, params }) => acceptMemberOrder(actor, params.id, await body(req, acceptOrderSchema)));
