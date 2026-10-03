import { body, route } from "@/server/http";
import { decideErasure, decideSchema } from "@/server/services/privacy";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => decideErasure(actor, params.id, await body(req, decideSchema)));
