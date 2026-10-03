import { route } from "@/server/http";
import { memberCard } from "@/server/services/members";

export const GET = route<{ id: string }>(async ({ actor, params }) => memberCard(actor, params.id));
