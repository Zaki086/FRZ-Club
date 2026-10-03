import { route } from "@/server/http";
import { deleteView } from "@/server/services/saved-views";

export const DELETE = route<{ id: string }>(async ({ actor, params }) => deleteView(actor, params.id));
