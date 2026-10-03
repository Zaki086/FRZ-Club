import { route } from "@/server/http";
import { setupStatus } from "@/server/services/setup";

export const GET = route(async ({ actor }) => setupStatus(actor));
