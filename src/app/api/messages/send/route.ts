// v5 §3.3 step 4: send a template to one record's recipient on the chosen channels (MT-4…MT-6, duplicate guard).
import { body, route } from "@/server/http";
import { sendSchema } from "@/server/services/messages/schemas";
import { sendMessage } from "@/server/services/messages/send";

export const POST = route(async ({ req, actor }) => sendMessage(actor, await body(req, sendSchema)));
