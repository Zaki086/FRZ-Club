import { route } from "@/server/http";
import { getTab } from "@/server/services/bar";

export const GET = route<{ id: string }>(async ({ actor, params }) => getTab(actor, params.id));
