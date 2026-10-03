import { route } from "@/server/http";
import { myDrawerBalance } from "@/server/services/drawers";

// CD-1: the header badge polls this (≤ 5 s); it is cheap — one session lookup and one sum.
export const GET = route(async ({ actor }) => myDrawerBalance(actor));
