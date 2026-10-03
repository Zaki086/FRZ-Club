import { body, route } from "@/server/http";
import { completeRefundSchema } from "@/server/services/payments";
import { payOutRefund } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => payOutRefund(actor, params.id, await body(req, completeRefundSchema)));
