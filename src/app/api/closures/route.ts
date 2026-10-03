import { body, route } from "@/server/http";
import { closeCourts, closureSchema } from "@/server/services/closures";

/** v3 CC-2: close the courts and cancel what is on them, in one transaction. */
export const POST = route(async ({ req, actor }) => closeCourts(actor, await body(req, closureSchema)));
