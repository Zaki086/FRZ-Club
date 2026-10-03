import { body, route } from "@/server/http";
import { clockOut, clockOutSchema } from "@/server/services/staff";

export const POST = route(async ({ req, actor }) => clockOut(actor, await body(req, clockOutSchema)));
