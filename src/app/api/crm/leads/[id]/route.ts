import { route } from "@/server/http";
import { getLead } from "@/server/services/crm";

export const GET = route<{ id: string }>(async ({ actor, params }) => getLead(actor, params.id));
