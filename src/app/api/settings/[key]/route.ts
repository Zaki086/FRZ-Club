import { z } from "zod";
import { body, route } from "@/server/http";
import { updateSetting, verifySetting } from "@/server/services/settings";

export const PUT = route<{ key: string }>(async ({ req, actor, params }) => updateSetting(actor, params.key, (await body(req, z.object({ value: z.unknown() }))).value));

/** Owner confirms seeded values (e.g. GST rates, IN-6). */
export const POST = route<{ key: string }>(async ({ actor, params }) => verifySetting(actor, params.key));
