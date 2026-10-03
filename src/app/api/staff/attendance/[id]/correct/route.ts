import { body, route } from "@/server/http";
import { correctAttendance, correctionSchema } from "@/server/services/attendance";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => correctAttendance(actor, params.id, await body(req, correctionSchema)));
