import { z } from "zod";
import { body, route } from "@/server/http";
import { cancelExpense } from "@/server/services/expenses";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => cancelExpense(actor, params.id, (await body(req, z.object({ reason: z.string().min(3) }))).reason));
