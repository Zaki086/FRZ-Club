import { route } from "@/server/http";
import { getPayrollRun } from "@/server/services/payroll";

export const GET = route<{ id: string }>(async ({ actor, params }) => getPayrollRun(actor, params.id));
