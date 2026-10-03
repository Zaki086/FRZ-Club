import { body, route } from "@/server/http";
import { courtSchema, createCourt, listCourts } from "@/server/services/courts";

export const GET = route(async () => listCourts({ includeInactive: true }), { auth: "optional" });

export const POST = route(async ({ req, actor }) => createCourt(actor, await body(req, courtSchema)));
