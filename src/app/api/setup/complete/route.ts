import { route } from "@/server/http";
import { completeSetup } from "@/server/services/setup";

export const POST = route(async ({ actor }) => completeSetup(actor));
