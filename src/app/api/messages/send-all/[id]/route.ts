// v6 SA-7 (SENDALL): live progress of a "Send all" job (sent / failed / remaining) and its summary when done.
import { route } from "@/server/http";
import { sendAllProgress } from "@/server/services/messages/send-all";

export const GET = route<{ id: string }>(async ({ actor, params }) => sendAllProgress(actor, params.id));
