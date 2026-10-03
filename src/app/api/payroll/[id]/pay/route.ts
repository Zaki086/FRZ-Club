import { body, route } from "@/server/http";
import { payPayrollRun, payRunSchema } from "@/server/services/payroll";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => payPayrollRun(actor, params.id, await body(req, payRunSchema)));
