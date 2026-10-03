import { body, route } from "@/server/http";
import { cancelBooking, cancelBookingSchema } from "@/server/services/booking";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => cancelBooking(actor, params.id, await body(req, cancelBookingSchema)));
