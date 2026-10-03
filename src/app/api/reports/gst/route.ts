import { query, route } from "@/server/http";
import { gstReport, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => gstReport(actor, query(req, periodSchema)));
