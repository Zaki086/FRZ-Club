import { body, route } from "@/server/http";
import { explainDrawerVariance, varianceReasonSchema } from "@/server/services/drawers";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => explainDrawerVariance(actor, params.id, (await body(req, varianceReasonSchema)).reason));
