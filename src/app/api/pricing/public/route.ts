import { route } from "@/server/http";
import { publicPriceNotes } from "@/server/services/price-book";

/** PR-14: current bands, special dates and promotions, for the public site and the portal. */
export const GET = route(async () => publicPriceNotes(), { auth: "optional" });
