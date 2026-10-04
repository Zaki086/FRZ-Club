// v5 §3.1: Settings → Message Templates (Owner edits; Manager reads).
import { query, route } from "@/server/http";
import { libraryQuerySchema } from "@/server/services/messages/schemas";
import { templateLibrary } from "@/server/services/messages/templates";

export const GET = route(async ({ req, actor }) => templateLibrary(actor, query(req, libraryQuerySchema)));
