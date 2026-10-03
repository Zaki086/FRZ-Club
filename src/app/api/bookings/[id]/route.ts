import { route } from "@/server/http";
import { getBooking } from "@/server/services/booking";

export const GET = route<{ id: string }>(async ({ actor, params }) => getBooking(actor, params.id));
