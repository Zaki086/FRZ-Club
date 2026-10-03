import { body, route } from "@/server/http";
import { sendTestEmail, testEmailSchema } from "@/server/services/messages";

export const POST = route(async ({ req, actor }) => sendTestEmail(actor, await body(req, testEmailSchema)));
