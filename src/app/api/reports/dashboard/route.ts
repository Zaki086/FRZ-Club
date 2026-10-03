import { query, route } from "@/server/http";
import { dashboard, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => dashboard(actor, query(req, periodSchema)));
