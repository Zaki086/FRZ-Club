// v5 §3.1: the template library (Settings → Message Templates). The Owner creates and edits templates; the Manager
// reads them (and both use them in the composer). MT-1: saving checks every `{{variable}}` against the context
// (UNKNOWN_TEMPLATE_VARIABLE). MT-3: every saved change is a new version (the old text stays for the Message Log);
// archive, never delete. The 18 ready-made templates are inserted by migration 0021 and by `ensureReadyMadeTemplates`.
import { Prisma, type MessageTemplate } from "@prisma/client";
import { clock } from "@/lib/clock";
import { prisma, withTx, type Tx } from "../../db";
import { DomainError } from "../../errors";
import { actorId, type Actor } from "../../rbac/actor";
import { assertCan, can } from "../../rbac/permissions";
import { audit } from "../audit";
import {
  TEMPLATE_CONTEXTS, WHATSAPP_MAX_CHARS,
  type LibraryResponse, type LibraryTemplate, type TemplateCategory, type TemplateChannel, type TemplateContext, type TemplateDetail, type VariablesResponse,
} from "./contract";
import { READY_MADE_TEMPLATES } from "./ready-made";
import { templateInputSchema, type TemplateInputParsed } from "./schemas";
import { AUTO_WHATSAPP, isAutoWhatsAppTemplate, unknownVariables, variablesForContext } from "./variables";

const CONTENT_KEYS = ["name", "context", "category", "channels", "whatsappText", "emailSubject", "emailBody", "pushTitle", "pushBody", "waTemplate"] as const;

function assertCanRead(actor: Actor) {
  if (can(actor, "messages.templates.manage") || can(actor, "messages.templates.view")) return;
  assertCan(actor, "messages.templates.view");
}

/** MT-1 and the channel rules: every chosen channel has its text, WhatsApp ≤ 700 characters, variables exist. */
export function validateTemplate(input: TemplateInputParsed): void {
  const texts = [input.whatsappText, input.emailSubject, input.emailBody, input.pushTitle, input.pushBody];
  const unknown = unknownVariables(input.context, texts);
  if (unknown.length) {
    const allowed = variablesForContext(input.context).map((v) => `{{${v.name}}}`).join(", ");
    throw new DomainError(
      "UNKNOWN_TEMPLATE_VARIABLE",
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not available for a ${input.context.toLowerCase()} template. You can use: ${allowed}.`,
      { unknown, context: input.context },
    );
  }
  const need = (ok: boolean, msg: string) => {
    if (!ok) throw new DomainError("VALIDATION_FAILED", msg);
  };
  const ch = new Set(input.channels);
  if (ch.has("WHATSAPP")) {
    need(!!input.whatsappText.trim(), "Write the WhatsApp text (or untick WhatsApp).");
    need(input.whatsappText.length <= WHATSAPP_MAX_CHARS, `Keep the WhatsApp text under ${WHATSAPP_MAX_CHARS} characters (it has ${input.whatsappText.length}).`);
  }
  if (ch.has("EMAIL")) need(!!input.emailSubject.trim() && !!input.emailBody.trim(), "Write the email subject and body (or untick Email).");
  if (ch.has("PUSH")) {
    need(!!input.pushTitle.trim() && !!input.pushBody.trim(), "Write the push title and text (or untick Push).");
    need(input.context !== "LEAD", "Leads have no app login, so push isn't possible for a lead template — untick Push.");
  }
  if (input.waTemplate) {
    need(isAutoWhatsAppTemplate(input.waTemplate), "Choose one of the listed WhatsApp templates for automatic sending.");
    const auto = AUTO_WHATSAPP[input.waTemplate as keyof typeof AUTO_WHATSAPP];
    need(auto.context === input.context, `The WhatsApp template ${input.waTemplate} needs a ${auto.context.toLowerCase()} template.`);
    need(ch.has("WHATSAPP"), "Automatic WhatsApp needs the WhatsApp channel.");
  }
}

type VersionRow = { version: number; name: string; category: string; channels: string[]; whatsappText: string; emailSubject: string; emailBody: string; pushTitle: string; pushBody: string; waTemplate: string | null; createdAt: Date; createdBy: string | null };

async function userNames(ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

function toLibrary(t: MessageTemplate, names: Map<string, string>, sends: number): LibraryTemplate {
  return {
    id: t.id, key: t.key, name: t.name, context: t.context as TemplateContext, category: t.category as TemplateCategory,
    channels: t.channels as TemplateChannel[], waTemplate: t.waTemplate, active: t.active, archivedAt: t.archivedAt?.toISOString() ?? null,
    version: t.version, updatedAt: t.updatedAt.toISOString(), updatedBy: (t.updatedBy && names.get(t.updatedBy)) ?? null, sends,
    whatsappText: t.whatsappText, emailSubject: t.emailSubject, emailBody: t.emailBody, pushTitle: t.pushTitle, pushBody: t.pushBody,
  };
}

async function sendCounts(ids?: string[]): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ template_id: string; n: bigint }[]>`
    SELECT template_id, count(DISTINCT COALESCE(send_id, id)) AS n FROM notification_deliveries
     WHERE template_id IS NOT NULL AND status <> 'SKIPPED' ${ids ? Prisma.sql`AND template_id = ANY(${ids}::text[])` : Prisma.empty}
     GROUP BY template_id`;
  return new Map(rows.map((r) => [r.template_id, Number(r.n)]));
}

/** Settings → Message Templates: every live template (and the archived ones with `archived=1`). */
export async function templateLibrary(actor: Actor, q: { archived?: "0" | "1" } = {}): Promise<LibraryResponse> {
  assertCanRead(actor);
  const rows = await prisma.messageTemplate.findMany({
    where: q.archived === "1" ? {} : { archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const [names, sends] = await Promise.all([userNames(rows.map((r) => r.updatedBy)), sendCounts()]);
  const order = (c: string) => TEMPLATE_CONTEXTS.indexOf(c as TemplateContext);
  rows.sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || order(a.context) - order(b.context) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return {
    templates: rows.map((r) => toLibrary(r, names, sends.get(r.id) ?? 0)),
    canManage: can(actor, "messages.templates.manage"),
    autoWhatsAppTemplates: Object.entries(AUTO_WHATSAPP).map(([name, v]) => ({ name, context: v.context, label: v.label })),
  };
}

/** One template with every version, newest first. */
export async function getTemplate(actor: Actor, id: string): Promise<TemplateDetail> {
  assertCanRead(actor);
  const t = await prisma.messageTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!t) throw new DomainError("NOT_FOUND", "Template was not found.");
  const names = await userNames([t.updatedBy, ...t.versions.map((v) => v.createdBy)]);
  const sends = await sendCounts([t.id]);
  return {
    ...toLibrary(t, names, sends.get(t.id) ?? 0),
    versions: t.versions.map((v: VersionRow) => ({
      version: v.version, name: v.name, category: v.category as TemplateCategory, channels: v.channels as TemplateChannel[],
      whatsappText: v.whatsappText, emailSubject: v.emailSubject, emailBody: v.emailBody, pushTitle: v.pushTitle, pushBody: v.pushBody,
      waTemplate: v.waTemplate, createdAt: v.createdAt.toISOString(), createdBy: (v.createdBy && names.get(v.createdBy)) ?? null,
    })),
  };
}

function versionData(t: Pick<MessageTemplate, "id" | "version" | "name" | "context" | "category" | "channels" | "whatsappText" | "emailSubject" | "emailBody" | "pushTitle" | "pushBody" | "waTemplate">, by: string | null) {
  return {
    id: `mtv_${t.id.replace(/^mt_/, "")}_${t.version}`.slice(0, 80), templateId: t.id, version: t.version, name: t.name, context: t.context, category: t.category,
    channels: t.channels, whatsappText: t.whatsappText, emailSubject: t.emailSubject, emailBody: t.emailBody, pushTitle: t.pushTitle, pushBody: t.pushBody,
    waTemplate: t.waTemplate, createdBy: by,
  };
}

function nameTaken(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
const NAME_TAKEN = () => new DomainError("VALIDATION_FAILED", "A template with this name already exists — choose another name.", { field: "name" });

/** The Owner adds a template (version 1). */
export async function createTemplate(actor: Actor, raw: unknown) {
  assertCan(actor, "messages.templates.manage");
  const input = templateInputSchema.parse(raw);
  validateTemplate(input);
  const by = actorId(actor);
  try {
    const t = await withTx(async (tx) => {
      const max = await tx.messageTemplate.aggregate({ _max: { sortOrder: true } });
      const created = await tx.messageTemplate.create({
        data: {
          id: `mt_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
          name: input.name, context: input.context, category: input.category, channels: input.channels,
          whatsappText: input.whatsappText, emailSubject: input.emailSubject, emailBody: input.emailBody, pushTitle: input.pushTitle, pushBody: input.pushBody,
          waTemplate: input.waTemplate ?? null, active: input.active ?? true, version: 1, sortOrder: (max._max.sortOrder ?? 0) + 10, createdBy: by, updatedBy: by,
        },
      });
      await tx.messageTemplateVersion.create({ data: versionData(created, by) });
      await audit(tx, actor, "message_template.create", "message_template", created.id, { after: { name: created.name, context: created.context, category: created.category, version: 1 } });
      return created;
    });
    return getTemplate(actor, t.id);
  } catch (e) {
    if (nameTaken(e)) throw NAME_TAKEN();
    throw e;
  }
}

/** MT-3: an edit of the text, channels, name, context or category is saved as a new version; switching it on/off isn't. */
export async function updateTemplate(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "messages.templates.manage");
  const input = templateInputSchema.parse(raw);
  validateTemplate(input);
  const by = actorId(actor);
  try {
    await withTx(async (tx: Tx) => {
      const cur = await tx.messageTemplate.findUnique({ where: { id } });
      if (!cur) throw new DomainError("NOT_FOUND", "Template was not found.");
      if (cur.archivedAt) throw new DomainError("ORDER_STATE_INVALID", "This template is archived — restore it before editing.");
      const next = { ...input, waTemplate: input.waTemplate ?? null };
      const changed = CONTENT_KEYS.filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
      const active = input.active ?? cur.active;
      if (!changed.length && active === cur.active) return;
      const version = changed.length ? cur.version + 1 : cur.version;
      const updated = await tx.messageTemplate.update({
        where: { id },
        data: {
          name: next.name, context: next.context, category: next.category, channels: next.channels, whatsappText: next.whatsappText, emailSubject: next.emailSubject,
          emailBody: next.emailBody, pushTitle: next.pushTitle, pushBody: next.pushBody, waTemplate: next.waTemplate, active, version, updatedBy: by, updatedAt: clock.now(),
        },
      });
      if (changed.length) await tx.messageTemplateVersion.create({ data: versionData(updated, by) });
      await audit(tx, actor, changed.length ? "message_template.edit" : (active ? "message_template.activate" : "message_template.deactivate"), "message_template", id, {
        before: { version: cur.version, active: cur.active, ...Object.fromEntries(changed.map((k) => [k, cur[k]])) },
        after: { version, active, ...Object.fromEntries(changed.map((k) => [k, next[k]])) },
      });
    });
  } catch (e) {
    if (nameTaken(e)) throw NAME_TAKEN();
    throw e;
  }
  return getTemplate(actor, id);
}

/** MT-3: archived templates leave the composer; their versions and sends stay. */
export async function archiveTemplate(actor: Actor, id: string) {
  assertCan(actor, "messages.templates.manage");
  await withTx(async (tx) => {
    const cur = await tx.messageTemplate.findUnique({ where: { id } });
    if (!cur) throw new DomainError("NOT_FOUND", "Template was not found.");
    if (cur.archivedAt) return;
    await tx.messageTemplate.update({ where: { id }, data: { archivedAt: clock.now(), active: false, updatedBy: actorId(actor), updatedAt: clock.now() } });
    await audit(tx, actor, "message_template.archive", "message_template", id, { before: { archived: false, active: cur.active }, after: { archived: true, active: false } });
  });
  return getTemplate(actor, id);
}

export async function restoreTemplate(actor: Actor, id: string) {
  assertCan(actor, "messages.templates.manage");
  try {
    await withTx(async (tx) => {
      const cur = await tx.messageTemplate.findUnique({ where: { id } });
      if (!cur) throw new DomainError("NOT_FOUND", "Template was not found.");
      if (!cur.archivedAt) return;
      await tx.messageTemplate.update({ where: { id }, data: { archivedAt: null, active: true, updatedBy: actorId(actor), updatedAt: clock.now() } });
      await audit(tx, actor, "message_template.restore", "message_template", id, { before: { archived: true }, after: { archived: false, active: true } });
    });
  } catch (e) {
    if (nameTaken(e)) throw NAME_TAKEN();
    throw e;
  }
  return getTemplate(actor, id);
}

/** The variables of each context (for the editor's variable list). */
export async function variablesFor(actor: Actor): Promise<VariablesResponse> {
  if (!can(actor, "messages.compose")) assertCanRead(actor);
  return Object.fromEntries(TEMPLATE_CONTEXTS.map((c) => [c, variablesForContext(c)])) as VariablesResponse;
}

/**
 * Insert any missing ready-made template (by key) with its version 1 — the same rows migration 0021 inserts on the
 * live club. Never touches a template that exists (the Owner's edits stay). Idempotent (seed, tests, demo reset).
 */
export async function ensureReadyMadeTemplates(outer?: Tx): Promise<number> {
  return withTx(async (tx) => {
    const r = await tx.messageTemplate.createMany({
      data: READY_MADE_TEMPLATES.map((t, i) => ({
        id: `mt_${t.key}`, key: t.key, name: t.name, context: t.context, category: t.category, channels: t.channels,
        whatsappText: t.whatsappText, emailSubject: t.emailSubject, emailBody: t.emailBody, pushTitle: t.pushTitle, pushBody: t.pushBody,
        waTemplate: t.waTemplate, sortOrder: (i + 1) * 10,
      })),
      skipDuplicates: true,
    });
    const fresh = await tx.messageTemplate.findMany({ where: { key: { in: READY_MADE_TEMPLATES.map((t) => t.key) }, version: 1 } });
    await tx.messageTemplateVersion.createMany({
      data: fresh.map((t) => ({ ...versionData(t, null), id: `mtv_${t.key}_1` })),
      skipDuplicates: true,
    });
    return r.count;
  }, outer);
}
