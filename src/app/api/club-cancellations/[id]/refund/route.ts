import { route } from "@/server/http";
import { refundClubCancellation } from "@/server/services/closures";

export const POST = route<{ id: string }>(async ({ actor, params }) => refundClubCancellation(actor, params.id));
