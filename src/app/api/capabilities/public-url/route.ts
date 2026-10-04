import { route } from "@/server/http";
import { publicUrlStatus } from "@/server/services/public-url";

/** v6 URL-2: Settings status line — the configured public address (APP_URL). */
export const GET = route(async ({ actor }) => publicUrlStatus(actor));
