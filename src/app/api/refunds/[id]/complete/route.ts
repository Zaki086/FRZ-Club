import { body, route } from "@/server/http";
import { payOutRefundPayment, payOutSchema } from "@/server/services/refunds";

/** The old per-payment pay-out: the same identity rule as /pay-out (RF-9), then the whole request is paid. */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => payOutRefundPayment(actor, params.id, await body(req, payOutSchema)));
