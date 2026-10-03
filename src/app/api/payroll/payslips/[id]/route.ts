import { route } from "@/server/http";
import { getPayslip } from "@/server/services/payroll";

export const GET = route<{ id: string }>(async ({ actor, params }) => getPayslip(actor, params.id));
