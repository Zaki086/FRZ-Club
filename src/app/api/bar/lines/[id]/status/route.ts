import { z } from "zod";
import { body, route } from "@/server/http";
import { setLineStatus } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params }) =>
  setLineStatus(actor, params.id, (await body(req, z.object({ status: z.enum(["PREPARING", "READY", "SERVED"]) }))).status),
);
