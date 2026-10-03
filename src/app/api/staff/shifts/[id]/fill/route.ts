import { z } from "zod";
import { body, route } from "@/server/http";
import { fillShift } from "@/server/services/staff";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => fillShift(actor, params.id, (await body(req, z.object({ employeeId: z.string() }))).employeeId));
