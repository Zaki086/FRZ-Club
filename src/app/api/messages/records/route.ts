// v5 §3.1 MT-2: search real records of a context to preview a template with.
import { query, route } from "@/server/http";
import { recordsQuerySchema } from "@/server/services/messages/schemas";
import { searchRecords } from "@/server/services/messages/records";

export const GET = route(async ({ req, actor }) => searchRecords(actor, query(req, recordsQuerySchema)));
