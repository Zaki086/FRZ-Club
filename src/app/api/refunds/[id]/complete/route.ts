import { body, route } from "@/server/http";
import { completeRefund, completeRefundSchema } from "@/server/services/payments";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => completeRefund(actor, params.id, await body(req, completeRefundSchema)));
