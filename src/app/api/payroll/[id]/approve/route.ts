import { route } from "@/server/http";
import { approvePayrollRun } from "@/server/services/payroll";

export const POST = route<{ id: string }>(async ({ actor, params }) => approvePayrollRun(actor, params.id));
