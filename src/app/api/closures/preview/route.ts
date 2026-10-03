import { body, route } from "@/server/http";
import { closureSchema, previewClosure } from "@/server/services/closures";

/** v3 CC-1: who and what closing these courts would cancel. Changes nothing. */
export const POST = route(async ({ req, actor }) => previewClosure(actor, await body(req, closureSchema)));
