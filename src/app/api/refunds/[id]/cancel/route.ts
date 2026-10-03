import { route } from "@/server/http";
import { cancelRefundRequest } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async ({ actor, params }) => cancelRefundRequest(actor, params.id));
