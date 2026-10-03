import { route } from "@/server/http";
import { collectableRefund } from "@/server/services/refunds";

export const GET = route<{ id: string }>(async ({ actor, params }) => collectableRefund(actor, params.id));
