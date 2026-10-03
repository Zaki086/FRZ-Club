import { route } from "@/server/http";
import { cancelMaintenance } from "@/server/services/booking";

/** Cancels (never deletes) a maintenance block. */
export const POST = route<{ id: string }>(async ({ actor, params }) => cancelMaintenance(actor, params.id));
