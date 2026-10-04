// v5 §3.3 composer: the templates for a context (+ record), most relevant first, each with the channels this recipient
// can receive. POST: the Owner creates a template (MT-1 variables checked; version 1).
import { body, query, route } from "@/server/http";
import { templateInputSchema, templatesQuerySchema } from "@/server/services/messages/schemas";
import { composerTemplates } from "@/server/services/messages/send";
import { createTemplate } from "@/server/services/messages/templates";

export const GET = route(async ({ req, actor }) => composerTemplates(actor, query(req, templatesQuerySchema)));
export const POST = route(async ({ req, actor }) => createTemplate(actor, await body(req, templateInputSchema)));
