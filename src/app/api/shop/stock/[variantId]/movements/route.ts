import { route } from "@/server/http";
import { listMovements } from "@/server/services/inventory";

export const GET = route<{ variantId: string }>(async ({ actor, params }) => listMovements(actor, params.variantId));
