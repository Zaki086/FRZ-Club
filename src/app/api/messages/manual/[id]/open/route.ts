import { z } from "zod";
import { body, route } from "@/server/http";
import { openManualMessage } from "@/server/services/channels";

// v6 SA-3: an EXPIRED task opens only with { confirmExpired: true } (else MESSAGE_EXPIRED, 409).
const openSchema = z.object({ confirmExpired: z.boolean().optional() }).default({});

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = req.headers.get("content-length") === "0" ? {} : await body(req, openSchema).catch(() => ({}));
  return openManualMessage(actor, params.id, input);
});
