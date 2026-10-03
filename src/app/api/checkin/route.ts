import { body, route } from "@/server/http";
import { checkIn, checkInSchema } from "@/server/services/checkin";

export const POST = route(async ({ req, actor }) => checkIn(actor, await body(req, checkInSchema)));
