import { route } from "@/server/http";
import { revokeShareLink } from "@/server/services/reports";

/** Revoke (links are kept for the audit trail, never deleted). */
export const POST = route<{ id: string }>(async ({ actor, params }) => revokeShareLink(actor, params.id));
