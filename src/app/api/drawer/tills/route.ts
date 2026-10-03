import { body, route } from "@/server/http";
import { createTill, listTills, tillSchema } from "@/server/services/drawers";

// §2.1: tills for the open dialog (any staff member) and for Settings (Owner, ?all=1 includes retired tills).
export const GET = route(async ({ req, actor }) => listTills(actor, { includeInactive: req.nextUrl.searchParams.get("all") === "1" }));
export const POST = route(async ({ req, actor }) => createTill(actor, await body(req, tillSchema)));
