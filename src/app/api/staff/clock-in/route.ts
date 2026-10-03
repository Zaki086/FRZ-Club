import { body, route } from "@/server/http";
import { clockIn, clockInSchema } from "@/server/services/staff";

export const POST = route(async ({ req, actor }) => clockIn(actor, await body(req, clockInSchema)));
