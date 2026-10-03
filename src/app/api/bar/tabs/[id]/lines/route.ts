import { body, route } from "@/server/http";
import { addLines, addLinesSchema } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => addLines(actor, params.id, await body(req, addLinesSchema)));
