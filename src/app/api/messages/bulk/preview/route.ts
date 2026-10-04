// v5 §3.4: before confirming a bulk send — the first 3 recipients rendered, who is skipped and why, duplicates.
import { body, route } from "@/server/http";
import { bulkSchema } from "@/server/services/messages/schemas";
import { previewBulkSend } from "@/server/services/messages/bulk";

export const POST = route(async ({ req, actor }) => previewBulkSend(actor, await body(req, bulkSchema)));
