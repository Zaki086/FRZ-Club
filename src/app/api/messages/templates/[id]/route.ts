// v5 §3.1 MT-3: one template with its versions; PATCH saves an edit as a new version (old versions stay for the log).
import { body, route } from "@/server/http";
import { templateUpdateSchema } from "@/server/services/messages/schemas";
import { getTemplate, updateTemplate } from "@/server/services/messages/templates";

export const GET = route<{ id: string }>(async ({ actor, params }) => getTemplate(actor, params.id));
export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateTemplate(actor, params.id, await body(req, templateUpdateSchema)));
