import { route } from "@/server/http";
import { listView } from "@/server/services/filters";

/** v3 §3.1: a filtered, paged list with facet counts and its summary strip. */
export const GET = route<{ name: string }>(async ({ req, actor, params }) => listView(actor, params.name, Object.fromEntries(req.nextUrl.searchParams)));
