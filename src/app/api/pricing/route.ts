import { route } from "@/server/http";
import { priceBook } from "@/server/services/price-book";

/** v3 §9.2: the whole price book (Manager/Owner). */
export const GET = route(async ({ actor }) => priceBook(actor));
