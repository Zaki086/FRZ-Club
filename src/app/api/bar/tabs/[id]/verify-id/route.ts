import { route } from "@/server/http";
import { verifyGuestId } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ actor, params }) => verifyGuestId(actor, params.id));
