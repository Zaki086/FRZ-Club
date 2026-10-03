import { route } from "@/server/http";
import { getBill } from "@/server/services/payments";

export const GET = route<{ id: string }>(async ({ actor, params }) => getBill(actor, params.id));
