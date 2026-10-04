// v5 §3.3–3.4: the composer's pure decisions (no React, no fetch) — kept here so they are unit-tested
// (tests/unit/v5-msgui.test.ts). The server decides everything that matters (templates, channels, rendering, roles,
// opt-outs, the duplicate guard); these only shape what the screens show and send.
import type { ListSelection } from "./list/filtered-list";
import {
  BULK_MAX,
  CHANNEL_LABEL,
  FILL_IN_RE,
  TEMPLATE_CHANNELS,
  type BulkProgress,
  type ChannelCounts,
  type ComposerTemplate,
  type DeliveryChannel,
  type DeliveryStatus,
  type DuplicateDetails,
  type RenderedMessage,
  type SendResult,
  type TemplateChannel,
  type TemplateContext,
  type TemplateOverrides,
} from "@/server/services/messages/contract";

// ───────── single send (composer) ─────────

/** Which template is picked when the composer opens: the server's most relevant one (it sorts them first), if any. */
export function initialTemplate(templates: ComposerTemplate[]): ComposerTemplate | null {
  return templates.find((t) => t.recommended) ?? null;
}

/** Only channels that are available for this recipient (and template) are offered; the others are hidden. */
export function offeredChannels(t: ComposerTemplate | null): TemplateChannel[] {
  if (!t) return [];
  return TEMPLATE_CHANNELS.filter((c) => t.availableChannels.includes(c) && t.channelOptions.some((o) => o.channel === c && o.available));
}

/** Why the hidden channels are hidden (a hint under the checkboxes). */
export function hiddenChannelReasons(t: ComposerTemplate | null): string[] {
  if (!t) return [];
  const offered = offeredChannels(t);
  return t.channelOptions.filter((o) => !offered.includes(o.channel) && o.reason).map((o) => `${CHANNEL_LABEL[o.channel]}: ${o.reason}`);
}

/** Pre-ticked channel when a template is picked: the first offered one (WhatsApp, then email, then push) — one message, not three. */
export function defaultChannels(t: ComposerTemplate | null): TemplateChannel[] {
  const offered = offeredChannels(t);
  return offered.length ? [offered[0]] : [];
}

/** Keep only the ticked channels that the (new) template still offers; fall back to its default. */
export function keepChannels(t: ComposerTemplate | null, ticked: TemplateChannel[]): TemplateChannel[] {
  const offered = offeredChannels(t);
  const kept = ticked.filter((c) => offered.includes(c));
  return kept.length ? kept : defaultChannels(t);
}

/** "Send automatically on WhatsApp" is offered only when the server says so for this template and WhatsApp is ticked. */
export function offerAutoWhatsApp(t: ComposerTemplate | null, channels: TemplateChannel[]): boolean {
  return !!t?.autoWhatsApp && channels.includes("WHATSAPP");
}

/** Will this send open a wa.me tab (manual WhatsApp)? Then the tab is opened inside the click. */
export function opensWhatsApp(channels: TemplateChannel[], auto: boolean): boolean {
  return channels.includes("WHATSAPP") && !auto;
}

/** The editable fields per channel (what "Edit for this send" changes; the template itself is unchanged). */
export const EDITABLE: Record<TemplateChannel, Array<keyof TemplateOverrides>> = {
  WHATSAPP: ["whatsappText"],
  EMAIL: ["emailSubject", "emailBody"],
  PUSH: ["pushTitle", "pushBody"],
};

/** Overrides sent with the message: only fields that were edited, for the ticked channels, and differ from the rendered text. */
export function overridesFor(channels: TemplateChannel[], edits: TemplateOverrides, rendered: TemplateOverrides): TemplateOverrides | undefined {
  const out: TemplateOverrides = {};
  for (const c of channels) {
    for (const k of EDITABLE[c]) {
      const v = edits[k];
      if (v !== undefined && v.trim() && v !== rendered[k]) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The email body to start an edit from: the plain-text alternative without what the layout adds after the body (the
 * button's "label: link" line, the "—" club block, why they receive it, unsubscribe). The server puts the layout
 * around an edited body again.
 */
export function emailBodyForEdit(text: string, link: string | null): string {
  let body = text;
  const footer = body.lastIndexOf("\n\n—");
  if (footer >= 0) body = body.slice(0, footer);
  if (link) {
    const cut = body.lastIndexOf("\n\n");
    if (cut >= 0 && body.slice(cut).trim().endsWith(link)) body = body.slice(0, cut);
  }
  return body.trim();
}

/** The text of a field as it will go out: what staff typed, else the template's (rendered) text. */
export function fieldValue(edits: TemplateOverrides, base: TemplateOverrides, f: keyof TemplateOverrides): string {
  return edits[f] ?? base[f] ?? "";
}

/** A `[[fill-in]]` part still in a ticked channel's text: the server refuses to send it, so staff must write it first. */
export function fillInLeft(channels: TemplateChannel[], edits: TemplateOverrides, base: TemplateOverrides): boolean {
  return channels.some((c) => EDITABLE[c].some((f) => FILL_IN_RE.test(fieldValue(edits, base, f))));
}

/** Channels whose template text has a `[[fill-in]]` part (their edit boxes open by themselves). */
export function channelsWithFillIn(channels: TemplateChannel[], base: TemplateOverrides): TemplateChannel[] {
  return channels.filter((c) => EDITABLE[c].some((f) => FILL_IN_RE.test(base[f] ?? "")));
}

/** The rendered text in the shape of the editable fields (to start an edit from, and to compare against). */
export function renderedFields(r: RenderedMessage | undefined, link: string | null): TemplateOverrides {
  return {
    whatsappText: r?.whatsapp?.text,
    emailSubject: r?.email?.subject,
    emailBody: r?.email ? emailBodyForEdit(r.email.text, link) : undefined,
    pushTitle: r?.push?.title,
    pushBody: r?.push?.body,
  };
}

export const DELIVERY_LABEL: Record<DeliveryChannel, string> = {
  WHATSAPP_MANUAL: "WhatsApp (by hand)", WHATSAPP_API: "WhatsApp (automatic)", EMAIL: "Email", PUSH: "Push",
};
export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  QUEUED: "Queued", SENT: "Sent", DELIVERED: "Delivered", FAILED: "Failed", LINK_OPENED: "WhatsApp opened", SKIPPED: "Not available",
};
export function statusTone(s: DeliveryStatus): "green" | "amber" | "red" | "blue" | "neutral" {
  return s === "SENT" || s === "DELIVERED" ? "green" : s === "FAILED" ? "red" : s === "LINK_OPENED" ? "blue" : s === "QUEUED" ? "amber" : "neutral";
}
/** What a result row says: manual WhatsApp waits for staff ("To send" until opened, then "Mark as sent"). */
export function resultLabel(r: Pick<SendResult, "channel" | "status">): string {
  if (r.channel === "WHATSAPP_MANUAL" && r.status === "QUEUED") return "To send";
  if (r.channel === "WHATSAPP_API" && r.status === "QUEUED") return "Queued — sent automatically";
  return STATUS_LABEL[r.status] ?? r.status;
}

/** The duplicate guard's question (DUPLICATE_RECENT_SEND). */
export function duplicateQuestion(d: Partial<DuplicateDetails> | null | undefined, name: string, when: (iso: string) => string): string {
  if (d?.recipients?.length) {
    const n = d.recipients.length;
    return `${n} recipient${n === 1 ? "" : "s"} got this message in the last 24 hours (${d.recipients.slice(0, 3).map((r) => r.name).join(", ")}${n > 3 ? "…" : ""}). Send it to them again?`;
  }
  const at = d?.lastSentAt ? ` on ${when(d.lastSentAt)}` : "";
  return `${name} already got this message${at}${d?.sentBy ? ` (sent by ${d.sentBy})` : ""}. Send it again?`;
}

// ───────── bulk ─────────

/** Bulk sends start from these lists; their templates come from this context (plus GENERAL ones). */
export function bulkContext(list: "members" | "renewals" | "checkin-risk" | "leads"): TemplateContext {
  return list === "leads" ? "LEAD" : "MEMBER";
}

/** Bulk: picked rows travel as ids; "all N matching the filter" travels as the list's query string (the server re-runs it). */
export function bulkTarget(sel: Pick<ListSelection, "ids" | "allMatching" | "qs">): { ids?: string[]; filter?: string } {
  if (sel.allMatching) {
    // Paging is not part of "matching": the server takes every matching row (up to its limit).
    const q = new URLSearchParams(sel.qs);
    q.delete("page");
    q.delete("size");
    return { filter: q.toString() };
  }
  return { ids: [...new Set(sel.ids)].slice(0, BULK_MAX) };
}

const sum = (c: ChannelCounts | undefined, k: keyof ChannelCounts) => c?.[k] ?? 0;

/** Progress of the worker's part (email, push, automatic WhatsApp): done / total, 0–100. */
export function bulkPercent(p: Pick<BulkProgress, "queued" | "status">): number {
  if (p.status === "DONE") return 100;
  const total = sum(p.queued, "total");
  if (!total) return 100;
  return Math.min(100, Math.round(((sum(p.queued, "sent") + sum(p.queued, "failed")) / total) * 100));
}

/** One line per delivery channel for the summary: "Email: 12 sent, 1 failed". */
export function bulkChannelLines(p: Pick<BulkProgress, "perChannel">): Array<{ channel: DeliveryChannel; label: string; text: string }> {
  const order: DeliveryChannel[] = ["WHATSAPP_MANUAL", "WHATSAPP_API", "EMAIL", "PUSH"];
  return order
    .filter((c) => p.perChannel[c] && p.perChannel[c]!.total > 0)
    .map((c) => {
      const x = p.perChannel[c]!;
      const parts =
        c === "WHATSAPP_MANUAL"
          ? [`${x.sent} sent`, x.linkOpened ? `${x.linkOpened} opened` : "", x.queued ? `${x.queued} to send` : ""]
          : [`${x.sent} sent`, x.failed ? `${x.failed} failed` : "", x.queued ? `${x.queued} queued` : ""];
      return { channel: c, label: DELIVERY_LABEL[c], text: parts.filter(Boolean).join(", ") };
    });
}

/** Are we finished with this bulk send? The worker is done and no manual WhatsApp is left to send. */
export function bulkFinished(p: Pick<BulkProgress, "status" | "manual">): boolean {
  return p.status === "DONE" && p.manual.toSend + p.manual.opened === 0;
}

// ───────── Messages to Send ("Send next") ─────────

/** One WhatsApp message waiting to be sent by hand (a row of the notification log). */
export type QueueRow = { id: string; status: string; title: string; member_name: string | null; recipient: string; to_address: string | null; created_at: string };

/** "Send next": the oldest message still to send that wasn't skipped in this run and isn't the one open now. */
export function nextInQueue(rows: QueueRow[], skipped: string[], currentId: string | null): QueueRow | null {
  return rows.find((r) => (r.status === "QUEUED" || r.status === "LINK_OPENED") && !skipped.includes(r.id) && r.id !== currentId) ?? null;
}

/**
 * Open a blank tab inside the click (pop-up blockers allow only that), to be pointed at wa.me once the server answers.
 * The new tab gets no handle back to the app.
 */
export function openPopup(): Window | null {
  if (typeof window === "undefined") return null;
  const w = window.open("", "_blank");
  if (w) w.opener = null;
  return w;
}
