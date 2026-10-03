import { route } from "@/server/http";
import { myRefundToken } from "@/server/services/refunds";

/** The member's collection QR value (RF-8) while the refund waits at the desk. */
export const GET = route<{ id: string }>(async ({ actor, params }) => myRefundToken(actor, params.id));
