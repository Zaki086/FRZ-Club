// v5 §3.4: bulk send from a list (selected rows or everyone matching the filter, max 500); GET: the latest bulk sends.
import { body, query, route } from "@/server/http";
import { bulkListQuerySchema, bulkSchema } from "@/server/services/messages/schemas";
import { createBulkSend, listBulkSends } from "@/server/services/messages/bulk";

export const GET = route(async ({ req, actor }) => listBulkSends(actor, query(req, bulkListQuerySchema)));
export const POST = route(async ({ req, actor }) => createBulkSend(actor, await body(req, bulkSchema)));
