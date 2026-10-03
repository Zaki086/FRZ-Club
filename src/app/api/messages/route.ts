import { query, route } from "@/server/http";
import { listMessages, messageQuerySchema } from "@/server/services/messages";

export const GET = route(async ({ req, actor }) => listMessages(actor, query(req, messageQuerySchema)));
