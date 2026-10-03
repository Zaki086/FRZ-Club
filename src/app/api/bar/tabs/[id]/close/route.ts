import { route } from "@/server/http";
import { closeTab } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ actor, params }) => closeTab(actor, params.id));
