import { route } from "@/server/http";
import { retryAtDesk } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async ({ actor, params }) => retryAtDesk(actor, params.id));
