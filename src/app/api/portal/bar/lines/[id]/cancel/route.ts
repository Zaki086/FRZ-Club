import { route } from "@/server/http";
import { cancelMemberLine } from "@/server/services/member-orders";

// v5 MO-8: the member removes a line while the bar has not accepted it yet.
export const POST = route<{ id: string }>(async ({ actor, params }) => cancelMemberLine(actor, params.id));
