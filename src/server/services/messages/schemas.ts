// v5 §3: Zod schemas of the /api/messages/* bodies and queries (the shapes are the types in contract.ts).
import { z } from "zod";
import { BULK_LISTS, BULK_MAX, TEMPLATE_CATEGORIES, TEMPLATE_CHANNELS, TEMPLATE_CONTEXTS } from "./contract";

const context = z.enum(TEMPLATE_CONTEXTS);
const channels = z.array(z.enum(TEMPLATE_CHANNELS)).max(3).transform((a) => [...new Set(a)]);
const id = z.string().trim().min(1).max(64);

/** Text limits: WhatsApp ≤ 700 characters (checked on the template source and again on the rendered text). */
export const templateInputSchema = z.object({
  name: z.string().trim().min(2, "Give the template a name (2–80 characters).").max(80),
  context,
  category: z.enum(TEMPLATE_CATEGORIES),
  channels: channels.refine((a) => a.length > 0, "Choose at least one channel."),
  whatsappText: z.string().trim().max(1000).default(""),
  emailSubject: z.string().trim().max(150).default(""),
  emailBody: z.string().trim().max(5000).default(""),
  pushTitle: z.string().trim().max(80).default(""),
  pushBody: z.string().trim().max(240).default(""),
  waTemplate: z.string().trim().max(60).nullable().optional(),
  active: z.boolean().optional(),
});
export type TemplateInputParsed = z.infer<typeof templateInputSchema>;

/** PATCH: the whole editable template (an edit is a new version, MT-3). */
export const templateUpdateSchema = templateInputSchema;

export const libraryQuerySchema = z.object({ archived: z.enum(["0", "1"]).optional() });

export const templatesQuerySchema = z.object({ context, recordId: id.optional() });

export const recordsQuerySchema = z.object({ context, q: z.string().trim().max(80).default("") });

const overrides = z.object({
  whatsappText: z.string().max(1000).optional(),
  emailSubject: z.string().max(150).optional(),
  emailBody: z.string().max(5000).optional(),
  pushTitle: z.string().max(80).optional(),
  pushBody: z.string().max(240).optional(),
}).optional();

export const previewSchema = z.union([
  z.object({ templateId: id, context, recordId: id, channels: channels.optional(), overrides }),
  z.object({ draft: templateInputSchema, recordId: id }),
]);

export const sendSchema = z.object({
  templateId: id,
  context,
  recordId: id,
  channels: channels.refine((a) => a.length > 0, "Choose at least one channel."),
  overrides,
  confirmDuplicate: z.boolean().optional(),
  autoWhatsApp: z.boolean().optional(),
});
export type SendInput = z.infer<typeof sendSchema>;

export const bulkSchema = z.object({
  templateId: id,
  list: z.enum(BULK_LISTS),
  ids: z.array(id).max(BULK_MAX, `At most ${BULK_MAX} recipients at a time.`).optional(),
  filter: z.string().max(2000).optional(),
  channels: channels.refine((a) => a.length > 0, "Choose at least one channel."),
  overrides,
  confirmDuplicate: z.boolean().optional(),
  autoWhatsApp: z.boolean().optional(),
}).refine((b) => (b.ids?.length ?? 0) > 0 || b.filter !== undefined, { message: "Select recipients or send to everyone matching the filter.", path: ["ids"] });
export type BulkInput = z.infer<typeof bulkSchema>;

export const bulkListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

export const unsubscribeSchema = z.object({ token: z.string().trim().min(10).max(300), resubscribe: z.boolean().optional() });
