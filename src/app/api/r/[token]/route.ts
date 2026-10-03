import { body, route } from "@/server/http";
import { clientIp } from "@/server/rate-limit";
import { linkChoiceSchema, resolveByLink, viewResolution } from "@/server/services/whatsapp/resolution";

// v4 §5.3: the signed club-cancellation link — no login; rate limited per device and per link (in the service).
export const GET = route<{ token: string }>(async ({ req, params }) => viewResolution(params.token, { ip: clientIp(req) }), { auth: "optional" });

export const POST = route<{ token: string }>(
  async ({ req, params }) => resolveByLink(params.token, await body(req, linkChoiceSchema), { ip: clientIp(req) }),
  { auth: "optional" },
);
