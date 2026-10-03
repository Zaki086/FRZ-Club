import { z } from "zod";
import { body, route } from "@/server/http";
import { rejectRefund } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => rejectRefund(actor, params.id, (await body(req, z.object({ note: z.string() }))).note));
