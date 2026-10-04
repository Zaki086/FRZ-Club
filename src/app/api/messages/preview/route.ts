// v5 §3.1 MT-2 / §3.3 step 3: the message rendered per channel for a real record (a saved template or an unsaved draft).
import { body, route } from "@/server/http";
import { previewSchema } from "@/server/services/messages/schemas";
import { previewMessage } from "@/server/services/messages/send";

export const POST = route(async ({ req, actor }) => previewMessage(actor, await body(req, previewSchema)));
