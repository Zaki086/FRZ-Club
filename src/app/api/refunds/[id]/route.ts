import { route } from "@/server/http";
import { getRefundRequest } from "@/server/services/refunds";

export const GET = route<{ id: string }>(async ({ actor, params }) => getRefundRequest(actor, params.id));
