import { route } from "@/server/http";
import { listDataRequests } from "@/server/services/privacy";

export const GET = route(async ({ actor }) => listDataRequests(actor));
