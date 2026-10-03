import { body, route } from "@/server/http";
import { devClockInfo, offsetSchema, setClockOffset } from "@/server/services/devtools";
import { assertCan } from "@/server/rbac/permissions";

export const GET = route(async ({ actor }) => {
  assertCan(actor, "dev_tools");
  return devClockInfo();
});

export const POST = route(async ({ req, actor }) => setClockOffset(actor, await body(req, offsetSchema)));
