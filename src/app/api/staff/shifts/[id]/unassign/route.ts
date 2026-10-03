import { route } from "@/server/http";
import { removeShift } from "@/server/services/staff";

export const POST = route<{ id: string }>(async ({ actor, params }) => removeShift(actor, params.id));
