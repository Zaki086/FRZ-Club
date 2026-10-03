import { route } from "@/server/http";
import { myBookings } from "@/server/services/booking";

export const GET = route(async ({ actor }) => myBookings(actor));
