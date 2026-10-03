import { route } from "@/server/http";
import { cancelPriceChange } from "@/server/services/price-book";

/** Withdraw a scheduled price change that hasn't started. */
export const DELETE = route<{ id: string }>(async ({ actor, params }) => cancelPriceChange(actor, params.id));
