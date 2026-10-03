import { z } from "zod";
import { body, route } from "@/server/http";
import { createPayrollRun, listPayrollRuns } from "@/server/services/payroll";

export const GET = route(async ({ actor }) => listPayrollRuns(actor));

export const POST = route(async ({ req, actor }) => createPayrollRun(actor, (await body(req, z.object({ month: z.string() }))).month));
