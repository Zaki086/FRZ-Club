import { route } from "@/server/http";
import { listExpiring } from "@/server/services/members";

export const GET = route(async ({ actor }) => listExpiring(actor));
