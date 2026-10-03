import { body, route } from "@/server/http";
import { rescheduleClubCancellation, rescheduleSchema } from "@/server/services/closures";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => rescheduleClubCancellation(actor, params.id, await body(req, rescheduleSchema)));
