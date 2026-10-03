import { body, route } from "@/server/http";
import { changePlayers, changePlayersSchema } from "@/server/services/booking";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => changePlayers(actor, params.id, await body(req, changePlayersSchema)));
