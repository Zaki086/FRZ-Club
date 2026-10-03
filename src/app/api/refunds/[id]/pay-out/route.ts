import { body, route } from "@/server/http";
import { payOutRefund, payOutSchema } from "@/server/services/refunds";

/** RF-9: pay out at the desk — the identity check is required and enforced by the service. */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => payOutRefund(actor, params.id, await body(req, payOutSchema)));
