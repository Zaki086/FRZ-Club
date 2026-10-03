import { body, route } from "@/server/http";
import { updatePlan, updatePlanSchema } from "@/server/services/plans";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updatePlan(actor, params.id, await body(req, updatePlanSchema)));
