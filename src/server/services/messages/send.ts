// v5 §3.3: the composer's server side — the templates for a record (most relevant first, each with the channels this
// recipient can receive), the preview per channel (MT-2), and the send itself:
//  - WhatsApp by hand: a QUEUED WHATSAPP_MANUAL row + the wa.me link (opening it through /api/messages/manual/<id>/open
//    records LINK_OPENED; staff then "Mark as sent").
//  - Email: sent right away through SMTP in the club's layout → SENT / FAILED.
//  - Push: one row per device, sent right away → SENT / FAILED (held until 07:00 in the quiet hours, NT-7).
//  - "Send automatically on WhatsApp": a WHATSAPP_API row sent after commit (v4 §5.4) when the template maps to an
//    approved Meta template and the person opted in.
// MT-4/MT-5 roles, channel availability and the 24-hour duplicate guard are enforced here, never only in the UI.
import type { MessageTemplate } from "@prisma/client";
import { clock } from "@/lib/clock";
import { afterCommit, prisma, withTx } from "../../db";
import { DomainError } from "../../errors";
import { type Actor } from "../../rbac/actor";
import { assertCan, can } from "../../rbac/permissions";
import { audit } from "../audit";
import { getCapabilities } from "../capabilities";
import { dispatchWhatsApp } from "../channels";
import type {
  ComposerTemplate, PreviewResponse, SendResponse, SendResult, TemplateChannel, TemplateContext, TemplatesResponse,
} from "./contract";
import {
  assertCanSendCategory, assertChannels, assertFilledIn, availability, clubInfo, deliverRow, planRows, pushDeviceCounts, recentSends,
  recipientKey, renderParts, renderedMessage, RUN_PREFIX, sendableTemplate, toRecipient, writeRows, type TemplateLike,
} from "./delivery";
import { loadRecord, recordForTemplate, templateFits, type LoadedRecord } from "./records";
import { previewSchema, sendSchema, templatesQuerySchema } from "./schemas";
import { validateTemplate } from "./templates";
import { waMeLink } from "./variables";

const PERSON_CONTEXTS: TemplateContext[] = ["BOOKING", "REFUND", "ORDER", "TAB", "INVOICE"];

async function devicesOf(userId: string | null) {
  return userId ? prisma.pushSubscription.findMany({ where: { userId }, select: { id: true, userAgent: true }, orderBy: { createdAt: "asc" } }) : [];
}

/** GET /api/messages/templates?context=&recordId= — what the composer offers for this record. */
export async function composerTemplates(actor: Actor, raw: unknown): Promise<TemplatesResponse> {
  assertCan(actor, "messages.compose");
  const q = templatesQuerySchema.parse(raw);
  const base = q.recordId ? await loadRecord(q.context, q.recordId) : null;
  const contexts: TemplateContext[] = [q.context, "GENERAL"];
  if (PERSON_CONTEXTS.includes(q.context) && (!base || base.memberId)) contexts.push("MEMBER");
  const rows = await prisma.messageTemplate.findMany({
    where: { active: true, archivedAt: null, context: { in: contexts }, ...(can(actor, "messages.announce") ? {} : { category: "TRANSACTIONAL" }) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const caps = await getCapabilities();
  const byContext = new Map<string, LoadedRecord>();
  const records = async (t: MessageTemplate) => {
    if (!base) return null;
    if (!templateFits(t.context as TemplateContext, base)) return null;
    if (!byContext.has(t.context)) byContext.set(t.context, await recordForTemplate(t.context as TemplateContext, q.context, base.id, base));
    return byContext.get(t.context)!;
  };
  const out: Array<ComposerTemplate & { rank: number }> = [];
  for (const t of rows) {
    const rec = await records(t);
    if (base && !rec) continue;
    const devices = rec?.person?.userId ? (await pushDeviceCounts([rec.person.userId])).get(rec.person.userId) ?? 0 : 0;
    const av = rec ? await availability(t, rec, devices, caps) : null;
    const options = av?.options ?? (t.channels as TemplateChannel[]).map((channel) => ({
      channel,
      available: channel === "WHATSAPP" || (channel === "EMAIL" ? caps.email.enabled : caps.push.enabled),
      reason: channel === "WHATSAPP" ? null : channel === "EMAIL" ? (caps.email.enabled ? null : `Email is not set up: ${caps.email.reason}`) : caps.push.enabled ? null : `Push is not set up: ${caps.push.reason}`,
    }));
    const last = rec?.person ? (await recentSends(t.id, [recipientKey(rec.person)])).values().next().value : undefined;
    const hint = base && t.key ? base.hints.indexOf(t.key) : -1;
    const tier = t.context === q.context ? 1 : t.context === "MEMBER" ? 2 : 3;
    out.push({
      id: t.id, key: t.key, name: t.name, context: t.context as TemplateContext, category: t.category as ComposerTemplate["category"], version: t.version,
      channels: t.channels as TemplateChannel[], channelOptions: options, availableChannels: options.filter((o) => o.available).map((o) => o.channel),
      autoWhatsApp: av?.auto ?? false, recommended: hint >= 0, canSend: true, lastSentAt: last?.at.toISOString() ?? null,
      rank: hint >= 0 ? hint : 100 + tier,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  const person = base ? (base.person ?? null) : null;
  const devices = person?.userId ? (await pushDeviceCounts([person.userId])).get(person.userId) ?? 0 : 0;
  return {
    context: q.context, recordId: base?.id ?? null, recipient: person ? toRecipient(person, devices) : null,
    templates: out.map(({ rank, ...t }) => (void rank, t)),
  };
}

/** POST /api/messages/preview — the message per channel for a real record (a saved template, or the editor's draft). */
export async function previewMessage(actor: Actor, raw: unknown): Promise<PreviewResponse> {
  const input = previewSchema.parse(raw);
  const club = await clubInfo();
  let t: TemplateLike;
  let rec: LoadedRecord;
  let channels: TemplateChannel[];
  let overrides;
  if ("draft" in input) {
    // MT-2: the Owner's editor previews unsaved text with a real record of the draft's context.
    if (!can(actor, "messages.templates.manage")) assertCan(actor, "messages.templates.view");
    validateTemplate(input.draft);
    t = { id: "draft", key: null, version: 0, waTemplate: input.draft.waTemplate ?? null, ...input.draft };
    rec = await loadRecord(input.draft.context, input.recordId);
    channels = input.draft.channels;
  } else {
    const tpl = await sendableTemplate(input.templateId);
    assertCanSendCategory(actor, tpl.category);
    t = tpl;
    rec = await recordForTemplate(tpl.context as TemplateContext, input.context, input.recordId);
    channels = (input.channels?.length ? input.channels : (tpl.channels as TemplateChannel[])).filter((c) => tpl.channels.includes(c));
    overrides = input.overrides;
  }
  if (!rec.person) throw new DomainError("VALIDATION_FAILED", "There is nobody to message on this record (no member or contact details).");
  const parts = renderParts(t, rec, club, overrides);
  const devices = rec.person.userId ? (await pushDeviceCounts([rec.person.userId])).get(rec.person.userId) ?? 0 : 0;
  return {
    templateId: t.id === "draft" ? null : t.id,
    version: t.id === "draft" ? null : t.version,
    recipient: toRecipient(rec.person, devices),
    link: parts.link,
    rendered: renderedMessage(parts, channels, rec.person, club, t.category, rec.person.kind),
  };
}

/** POST /api/messages/send — one template to one record's person on the chosen channels. */
export async function sendMessage(actor: Actor, raw: unknown): Promise<SendResponse> {
  const input = sendSchema.parse(raw);
  const t = await sendableTemplate(input.templateId);
  assertCanSendCategory(actor, t.category);
  const rec = await recordForTemplate(t.context as TemplateContext, input.context, input.recordId);
  const person = rec.person;
  if (!person) throw new DomainError("VALIDATION_FAILED", "There is nobody to message on this record (no member or contact details).");
  const channels = input.channels;
  const devices = await devicesOf(person.userId);
  const av = await availability(t, rec, devices.length);
  const auto = !!input.autoWhatsApp && channels.includes("WHATSAPP");
  assertChannels(av, channels, auto);
  const club = await clubInfo();
  const parts = renderParts(t, rec, club, input.overrides);
  assertFilledIn(parts, channels);

  // Duplicate guard: the same template to the same person within 24 h needs a confirmation.
  const key = recipientKey(person);
  const last = (await recentSends(t.id, [key])).get(key);
  if (last && !input.confirmDuplicate) {
    const by = last.by && last.by !== "system" ? await prisma.user.findUnique({ where: { id: last.by }, select: { name: true } }) : null;
    throw new DomainError("DUPLICATE_RECENT_SEND", `"${t.name}" was already sent to ${person.name} ${ago(last.at)}${by ? ` by ${by.name}` : ""}. Send it again?`, {
      lastSentAt: last.at.toISOString(), sentBy: by?.name ?? null,
    });
  }

  const sendId = `s${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const claim = `${RUN_PREFIX}${sendId}`;
  const rows = await planRows({ template: t, rec, person, sendId, actor }, parts, channels, { autoWhatsApp: auto, claim, devices });
  await withTx(async (tx) => {
    await writeRows(tx, rows);
    await audit(tx, actor, "message.send", "message_template", t.id, {
      after: {
        template: t.name, version: t.version, record: rec.label, recipient: key, channels: rows.map((r) => r.channel), sendId,
        edited: input.overrides ? Object.keys(input.overrides) : [], duplicateConfirmed: !!last,
      },
    });
    const apiIds = rows.filter((r) => r.channel === "WHATSAPP_API").map((r) => r.id);
    if (apiIds.length) afterCommit(tx, () => dispatchWhatsApp(apiIds));
  });

  // Email and push go out now (the request waits for them); a push in the quiet hours stays queued until 07:00.
  const caps = await getCapabilities();
  const results: SendResult[] = [];
  for (const r of rows) {
    if ((r.channel === "EMAIL" || r.channel === "PUSH") && r.handledBy === claim) {
      const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: r.id } });
      const status = await deliverRow(row, caps);
      const after = status === "FAILED" ? await prisma.notificationDelivery.findUnique({ where: { id: r.id }, select: { error: true } }) : null;
      results.push({ channel: r.channel, status, deliveryId: r.id, ...(r.channel === "PUSH" ? { device: r.toAddress ?? undefined } : {}), error: after?.error ?? null });
    } else if (r.channel === "WHATSAPP_MANUAL") {
      results.push({ channel: r.channel, status: "QUEUED", deliveryId: r.id, waLink: waMeLink(r.toAddress!, parts.whatsapp), error: null });
    } else {
      results.push({ channel: r.channel, status: "QUEUED", deliveryId: r.id, ...(r.channel === "PUSH" ? { device: r.toAddress ?? undefined } : {}), error: r.channel === "PUSH" ? "Held until 07:00 (quiet hours)" : null });
    }
  }
  return { sendId, templateId: t.id, version: t.version, recipient: toRecipient(person, devices.length), results };
}

function ago(at: Date): string {
  const min = Math.max(1, Math.round((clock.now().getTime() - at.getTime()) / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}
