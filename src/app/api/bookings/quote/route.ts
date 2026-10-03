import { z } from "zod";
import { body, route } from "@/server/http";
import { playerInputSchema, quoteBooking } from "@/server/services/booking";

// PR-9: preview only — confirming a booking recomputes every price on the server.
const schema = z.object({ courtId: z.string(), date: z.string(), startTime: z.string(), players: z.array(playerInputSchema).min(1) });

export const POST = route(async ({ req, actor }) => quoteBooking(actor, await body(req, schema)));
