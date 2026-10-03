import { route } from "@/server/http";
import { capabilityStatus } from "@/server/services/capabilities";

export const GET = route(async ({ actor }) => capabilityStatus(actor));
