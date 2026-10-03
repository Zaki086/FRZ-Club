import { query, route } from "@/server/http";
import { gstr1, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => gstr1(actor, query(req, periodSchema)));
