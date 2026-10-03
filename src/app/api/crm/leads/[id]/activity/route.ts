import { body, route } from "@/server/http";
import { activitySchema, logActivity } from "@/server/services/crm";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => logActivity(actor, params.id, await body(req, activitySchema)));
