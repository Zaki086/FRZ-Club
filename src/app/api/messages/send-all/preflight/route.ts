// v6 SA-6 (SENDALL): the preflight of "Send all" — counts per channel, skipped, can't send, one sample per channel.
import { body, route } from "@/server/http";
import { sendAllPreflight, sendAllSchema } from "@/server/services/messages/send-all";

export const POST = route(async ({ req, actor }) => sendAllPreflight(actor, await body(req, sendAllSchema)));
