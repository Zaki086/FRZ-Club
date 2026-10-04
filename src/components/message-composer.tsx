"use client";
// v5 §3.3: the message composer — "Send message" on a record opens it prefilled with that record.
//  1. a template (only this context's and general ones the role may send — front desk never sees announcements;
//     the most relevant first, pre-picked), 2. the channels this recipient can receive (others hidden),
//  3. the preview per channel, rendered by the server, editable for this send only (the template is unchanged),
//  4. send: manual WhatsApp opens wa.me (logged LINK_OPENED) and waits for "Mark as sent"; email and push show
//     SENT/FAILED per channel and device; "Send automatically on WhatsApp" only when the server offers it.
//  A repeat of the same template to the same person within 24 h asks first (DUPLICATE_RECENT_SEND).
import { useEffect, useState, type ReactNode } from "react";
import { Check, MessageCircle, MessageSquareText, Pencil, RotateCcw, Send } from "lucide-react";
import { api, ApiError, useApi } from "./api";
import { useListReload } from "./list/filtered-list";
import { DataState, Empty, Loading, RejectionBanner } from "./states";
import { Badge } from "./ui/badge";
import { Button, type ButtonProps } from "./ui/button";
import { Dialog, DialogContent, DialogTrigger } from "./ui/dialog";
import { Input, Textarea } from "./ui/input";
import { cn } from "./ui/cn";
import { fmtDateTime } from "@/lib/time";
import {
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  FILL_IN_RE,
  MESSAGE_API,
  MESSAGE_ERRORS,
  WHATSAPP_MAX_CHARS,
  type ComposerTemplate,
  type DuplicateDetails,
  type PreviewResponse,
  type Recipient,
  type RenderedMessage,
  type SendResponse,
  type SendResult,
  type TemplateChannel,
  type TemplateContext,
  type TemplateOverrides,
  type TemplatesResponse,
} from "@/server/services/messages/contract";
import {
  channelsWithFillIn,
  defaultChannels,
  duplicateQuestion,
  EDITABLE,
  fieldValue,
  fillInLeft,
  hiddenChannelReasons,
  initialTemplate,
  keepChannels,
  offerAutoWhatsApp,
  offeredChannels,
  openPopup,
  opensWhatsApp,
  overridesFor,
  renderedFields,
  resultLabel,
  statusTone,
  DELIVERY_LABEL,
} from "./message-composer-logic";

export type Rejection = { code?: string; message: string } | null;
export const toRejection = (e: unknown): Rejection => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

/** POST that re-runs when its body changes (debounced), keeping the last answer on screen while the next one loads. */
export function usePostPreview<T>(url: string, body: unknown | null) {
  const key = body ? JSON.stringify(body) : null;
  const [state, setState] = useState<{ key: string; data?: T; error?: Rejection } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<T>(url, { body: JSON.parse(key) })
        .then((d) => { if (!cancelled) setState({ key, data: d }); })
        .catch((e) => { if (!cancelled) setState({ key, error: toRejection(e) }); });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [url, key]);
  const current = key && state?.key === key ? state : null;
  return { data: current?.data ?? (key ? state?.data : undefined), error: current?.error ?? null, loading: !!key && !current };
}

/** One line per recipient: name, masked phone, masked email and the number of push devices. */
export function RecipientLine({ r }: { r: Recipient }) {
  const bits = [r.phone, r.email, r.pushDevices ? `${r.pushDevices} device${r.pushDevices === 1 ? "" : "s"} with push` : null].filter(Boolean);
  return (
    <p className="text-sm" data-testid="composer-recipient">
      To <span className="font-semibold">{r.name}</span>
      {bits.length ? <span className="text-muted-foreground"> · {bits.join(" · ")}</span> : null}
    </p>
  );
}

/** Step 1: the template list (radio buttons), most relevant first. */
export function TemplatePicker({ templates, value, onChange }: { templates: ComposerTemplate[]; value: string | null; onChange: (t: ComposerTemplate) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-semibold">1. Template</legend>
      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl border p-1" role="radiogroup" aria-label="Template" data-testid="composer-templates">
        {templates.map((t) => (
          <label
            key={t.id}
            className={cn("flex cursor-pointer flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary", value === t.id && "bg-primary/10")}
          >
            <input type="radio" name="message-template" className="accent-primary" checked={value === t.id} onChange={() => onChange(t)} aria-label={t.name} />
            <span className="font-medium">{t.name}</span>
            {t.recommended ? <Badge tone="green">Suggested</Badge> : null}
            {t.category === "ANNOUNCEMENT" ? <Badge tone="purple">{CATEGORY_LABEL.ANNOUNCEMENT}</Badge> : null}
            {t.lastSentAt ? <span className="text-xs text-warning-text">sent {fmtDateTime(t.lastSentAt)}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Step 2: the channels offered (unavailable ones are hidden; why, in one muted line), and the automatic WhatsApp option. */
export function ChannelPicker({ template, value, onChange, auto, onAuto, detail }: {
  template: ComposerTemplate | null;
  value: TemplateChannel[];
  onChange: (c: TemplateChannel[]) => void;
  auto: boolean;
  onAuto: (v: boolean) => void;
  detail?: (c: TemplateChannel) => string | null;
}) {
  const offered = offeredChannels(template);
  const hidden = hiddenChannelReasons(template);
  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="composer-channels">
      <legend className="mb-1 text-sm font-semibold">2. Channels</legend>
      {template && !offered.length ? (
        <p className="text-sm text-destructive" data-testid="composer-no-channel">This message can&apos;t be sent on any channel here.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {offered.map((c) => {
          const on = value.includes(c);
          const d = detail?.(c);
          return (
            <label key={c} className={cn("flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm", on ? "border-primary bg-primary/10" : "border-input")}>
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={on}
                onChange={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
                aria-label={CHANNEL_LABEL[c]}
              />
              <span className="font-semibold">{CHANNEL_LABEL[c]}</span>
              {d ? <span className="text-xs text-muted-foreground">{d}</span> : null}
            </label>
          );
        })}
      </div>
      {offerAutoWhatsApp(template, value) ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={auto} onChange={(e) => onAuto(e.target.checked)} data-testid="composer-auto-whatsapp" />
          Send automatically on WhatsApp (approved template, no phone needed)
        </label>
      ) : null}
      {hidden.length ? <p className="text-xs text-muted-foreground">Not offered — {hidden.join(" · ")}</p> : null}
    </fieldset>
  );
}

/** The rendered email in its layout (scripts off). */
export function EmailFrame({ html, className }: { html: string; className?: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={html} className={cn("h-72 w-full rounded-lg border bg-white", className)} />;
}

/** Read-only rendering of one recipient's message (bulk samples). */
export function RenderedView({ rendered, channels }: { rendered: RenderedMessage; channels: TemplateChannel[] }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {channels.includes("WHATSAPP") && rendered.whatsapp ? (
        <div><p className="text-xs font-semibold text-muted-foreground">WhatsApp</p><p className="whitespace-pre-line rounded-lg bg-success/10 p-2">{rendered.whatsapp.text}</p></div>
      ) : null}
      {channels.includes("EMAIL") && rendered.email ? (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Email · {rendered.email.subject}</summary>
          <EmailFrame html={rendered.email.html} className="mt-1 h-56" />
        </details>
      ) : null}
      {channels.includes("PUSH") && rendered.push ? (
        <div><p className="text-xs font-semibold text-muted-foreground">Push</p><p className="rounded-lg bg-secondary p-2"><span className="font-semibold">{rendered.push.title}</span><br />{rendered.push.body}</p></div>
      ) : null}
    </div>
  );
}

function PreviewCard({ title, editing, onEdit, onReset, edited, children, testId }: {
  title: string; editing: boolean; onEdit: () => void; onReset: () => void; edited: boolean; children: ReactNode; testId: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}{edited ? <span className="ml-2 text-xs font-normal text-warning-text">edited for this send</span> : null}</p>
        <span className="flex gap-1">
          {edited ? <Button size="sm" variant="ghost" onClick={onReset}><RotateCcw className="h-3.5 w-3.5" /> Template text</Button> : null}
          {!editing ? <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${title}`}><Pencil className="h-3.5 w-3.5" /> Edit</Button> : null}
        </span>
      </div>
      {children}
    </div>
  );
}

const FIELD: Record<keyof TemplateOverrides, { label: string; rows: number; max: number }> = {
  whatsappText: { label: "WhatsApp text", rows: 7, max: WHATSAPP_MAX_CHARS },
  emailSubject: { label: "Email subject", rows: 0, max: 150 },
  emailBody: { label: "Email message", rows: 8, max: 5000 },
  pushTitle: { label: "Push title", rows: 0, max: 80 },
  pushBody: { label: "Push text", rows: 3, max: 240 },
};

/** The edit boxes of one channel ("for this send only"). A `[[…]]` part left in is pointed out: it must be written first. */
export function ChannelFields({ channel, edits, base, onEdits }: {
  channel: TemplateChannel; edits: TemplateOverrides; base: TemplateOverrides; onEdits: (e: TemplateOverrides) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {EDITABLE[channel].map((f) => {
        const v = fieldValue(edits, base, f);
        const { label, rows, max } = FIELD[f];
        const fill = FILL_IN_RE.test(v);
        const set = (x: string) => onEdits({ ...edits, [f]: x });
        return (
          <div key={f} className="flex flex-col gap-1">
            {rows ? (
              <Textarea rows={rows} value={v} onChange={(e) => set(e.target.value)} aria-label={label} className={cn(fill && "border-warning")} />
            ) : (
              <Input value={v} onChange={(e) => set(e.target.value)} aria-label={label} maxLength={max} className={cn(fill && "border-warning")} />
            )}
            <p className="flex justify-between gap-2 text-xs">
              <span className={fill ? "font-semibold text-warning-text" : "text-muted-foreground"}>
                {fill ? "Write the part in [[double brackets]] before sending." : f === "emailBody" ? "The club's email layout (logo, button, footer) is added around this text." : ""}
              </span>
              {f === "whatsappText" || f === "pushBody" ? <span className={v.length > max ? "text-destructive" : "text-muted-foreground"}>{v.length} / {max}</span> : null}
            </p>
          </div>
        );
      })}
    </div>
  );
}

type ManualState = Record<string, "QUEUED" | "LINK_OPENED" | "SENT">;

/** Step 4 result: per channel (and per push device) — manual WhatsApp waits for "Mark as sent". */
function Results({ sent, manual, onOpen, onMarkSent, busy }: {
  sent: SendResponse; manual: ManualState; onOpen: (r: SendResult) => void; onMarkSent: (r: SendResult) => void; busy: boolean;
}) {
  return (
    <ul className="divide-y rounded-xl border" data-testid="composer-results">
      {sent.results.map((r) => {
        const m = r.channel === "WHATSAPP_MANUAL" ? manual[r.deliveryId] ?? "QUEUED" : null;
        const status = m ?? r.status;
        return (
          <li key={`${r.deliveryId}-${r.device ?? ""}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`result-${r.channel}`}>
            <span className="font-semibold">{DELIVERY_LABEL[r.channel]}</span>
            {r.device ? <span className="text-muted-foreground">{r.device}</span> : null}
            <Badge tone={statusTone(status)} title={r.error ?? undefined}>{resultLabel({ channel: r.channel, status })}</Badge>
            {r.error ? <span className={cn("text-xs", r.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>{r.error}</span> : null}
            {m === "QUEUED" ? (
              <Button size="sm" className="ml-auto" disabled={busy} onClick={() => onOpen(r)}><MessageCircle className="h-4 w-4" /> Open WhatsApp</Button>
            ) : m === "LINK_OPENED" ? (
              <span className="ml-auto flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">Send it from the club phone, then</span>
                <Button size="sm" disabled={busy} onClick={() => onMarkSent(r)} data-testid="composer-mark-sent">Mark as sent</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpen(r)}>Open again</Button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Composer({ context, recordId, onClose, onSent }: { context: TemplateContext; recordId: string; onClose: () => void; onSent?: () => void }) {
  const lib = useApi<TemplatesResponse>(`${MESSAGE_API.templates}?context=${context}&recordId=${encodeURIComponent(recordId)}`);
  const [picked, setPicked] = useState<string | null>(null);
  const [ticked, setTicked] = useState<TemplateChannel[] | null>(null);
  const [auto, setAuto] = useState(false);
  const [edits, setEdits] = useState<TemplateOverrides>({});
  const [editing, setEditing] = useState<TemplateChannel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [dup, setDup] = useState<DuplicateDetails | null>(null);
  const [sent, setSent] = useState<SendResponse | null>(null);
  const [manual, setManual] = useState<ManualState>({});

  const templates = lib.data?.templates ?? [];
  const template = templates.find((t) => t.id === picked) ?? (picked ? null : initialTemplate(templates));
  const channels = ticked ?? defaultChannels(template);
  const autoOn = auto && offerAutoWhatsApp(template, channels);
  const preview = usePostPreview<PreviewResponse>(
    MESSAGE_API.preview,
    template && channels.length && !sent ? { templateId: template.id, context, recordId, channels } : null,
  );
  // The last answer is kept on screen while the next loads — but never another template's text.
  const pv = preview.data && preview.data.templateId === template?.id ? preview.data : undefined;
  const rendered = renderedFields(pv?.rendered, pv?.link ?? null);
  const overrides = overridesFor(channels, edits, rendered);
  const recipient = pv?.recipient ?? lib.data?.recipient ?? null;
  // A template with a [[fill-in]] part (e.g. a club notice) opens its edit boxes by itself and can't go out until written.
  const autoEdit = pv ? channelsWithFillIn(channels, rendered) : [];
  const isEditing = (c: TemplateChannel) => editing.includes(c) || autoEdit.includes(c);
  const blocked = !!pv && fillInLeft(channels, edits, rendered);

  const pick = (t: ComposerTemplate) => {
    setPicked(t.id);
    setTicked(keepChannels(t, channels));
    setEdits({});
    setEditing([]);
    setAuto(false);
    setError(null);
  };
  const startEdit = (c: TemplateChannel) => setEditing((e) => [...e, c]);
  const reset = (c: TemplateChannel) => {
    setEditing((e) => e.filter((x) => x !== c));
    setEdits((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !EDITABLE[c].includes(k as keyof TemplateOverrides))));
  };
  const edited = (c: TemplateChannel) => EDITABLE[c].some((f) => overrides?.[f] !== undefined);
  const card = (c: TemplateChannel, title: string, view: ReactNode) => (
    <PreviewCard title={title} testId={`preview-${c}`} editing={isEditing(c)} edited={edited(c)} onEdit={() => startEdit(c)} onReset={() => reset(c)}>
      {isEditing(c) ? <ChannelFields channel={c} edits={edits} base={rendered} onEdits={setEdits} /> : view}
    </PreviewCard>
  );

  const openManual = async (r: SendResult, popup: Window | null) => {
    try {
      const o = await api<{ url: string }>(MESSAGE_API.manualOpen(r.deliveryId), { body: {} });
      if (popup) popup.location.href = o.url;
      setManual((m) => ({ ...m, [r.deliveryId]: "LINK_OPENED" }));
    } catch (e) {
      popup?.close();
      setError(toRejection(e));
    }
  };

  const send = async (confirmDuplicate: boolean) => {
    if (!template) return;
    // The wa.me tab is opened inside the click (pop-up blockers), then pointed at the link once the server answers.
    const popup = opensWhatsApp(channels, autoOn) ? openPopup() : null;
    setBusy(true);
    setError(null);
    try {
      const res = await api<SendResponse>(MESSAGE_API.send, {
        body: { templateId: template.id, context, recordId, channels, overrides, confirmDuplicate: confirmDuplicate || undefined, autoWhatsApp: autoOn || undefined },
      });
      setDup(null);
      setSent(res);
      onSent?.();
      const wa = res.results.find((r) => r.channel === "WHATSAPP_MANUAL");
      if (wa && popup) await openManual(wa, popup);
      else popup?.close();
    } catch (e) {
      popup?.close();
      if (e instanceof ApiError && e.code === MESSAGE_ERRORS.DUPLICATE_RECENT_SEND) setDup((e.details ?? {}) as DuplicateDetails);
      else setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };

  const markSent = async (r: SendResult) => {
    setBusy(true);
    setError(null);
    try {
      await api(MESSAGE_API.manualSent(r.deliveryId), { body: {} });
      setManual((m) => ({ ...m, [r.deliveryId]: "SENT" }));
      onSent?.();
    } catch (e) {
      setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    const waiting = sent.results.some((r) => r.channel === "WHATSAPP_MANUAL" && manual[r.deliveryId] !== "SENT");
    return (
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-success-text" />
          <span><span className="font-semibold">{template?.name}</span> to <span className="font-semibold">{sent.recipient.name}</span></span>
        </p>
        <Results sent={sent} manual={manual} busy={busy} onOpen={(r) => { const p = openPopup(); void openManual(r, p); }} onMarkSent={markSent} />
        <RejectionBanner error={error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant={waiting ? "outline" : "default"} onClick={onClose} data-testid="composer-done">{waiting ? "Close (send later from Messages to Send)" : "Done"}</Button>
        </div>
      </div>
    );
  }

  return (
    <DataState state={lib}>
      {(d) =>
        d.templates.length === 0 ? (
          <Empty title="No message templates for this" hint="The Owner adds templates in Settings → Message Templates." />
        ) : (
          <div className="flex flex-col gap-4" data-testid="message-composer">
            {recipient ? <RecipientLine r={recipient} /> : null}
            <TemplatePicker templates={d.templates} value={template?.id ?? null} onChange={pick} />
            <ChannelPicker
              template={template}
              value={channels}
              onChange={(c) => setTicked(c)}
              auto={auto}
              onAuto={setAuto}
              detail={(c) => (c === "WHATSAPP" ? (autoOn ? "automatic" : recipient?.phone ?? null) : c === "EMAIL" ? recipient?.email ?? null : recipient?.pushDevices ? `${recipient.pushDevices} device${recipient.pushDevices === 1 ? "" : "s"}` : null)}
            />
            {template && channels.length ? (
              <section className="flex flex-col gap-2" aria-label="Preview">
                <p className="text-sm font-semibold">3. Preview <span className="font-normal text-muted-foreground">— edit for this send only; the template stays as it is</span></p>
                <RejectionBanner error={preview.error} />
                {!pv ? <Loading label="Rendering…" /> : (
                  <>
                    {channels.includes("WHATSAPP") && pv.rendered.whatsapp
                      ? card("WHATSAPP", "WhatsApp", <p className="whitespace-pre-line rounded-lg bg-success/10 p-2 text-sm">{pv.rendered.whatsapp.text}</p>)
                      : null}
                    {channels.includes("EMAIL") && pv.rendered.email
                      ? card("EMAIL", "Email", (
                        <>
                          <p className="text-sm"><span className="text-muted-foreground">Subject:</span> <span className="font-semibold">{pv.rendered.email.subject}</span></p>
                          <EmailFrame html={pv.rendered.email.html} />
                        </>
                      ))
                      : null}
                    {channels.includes("PUSH") && pv.rendered.push
                      ? card("PUSH", "Push", <p className="rounded-lg bg-secondary p-2 text-sm"><span className="font-semibold">{pv.rendered.push.title}</span><br />{pv.rendered.push.body}</p>)
                      : null}
                  </>
                )}
              </section>
            ) : null}
            {dup ? (
              <div role="alertdialog" aria-label="Sent recently" className="flex flex-col gap-2 rounded-xl border border-warning/60 bg-warning/15 p-3 text-sm" data-testid="duplicate-guard">
                <p>{duplicateQuestion(dup, recipient?.name ?? "This person", fmtDateTime)}</p>
                <span className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDup(null)}>Don&apos;t send</Button>
                  <Button size="sm" disabled={busy} onClick={() => send(true)} data-testid="duplicate-confirm">Send again</Button>
                </span>
              </div>
            ) : null}
            <RejectionBanner error={error} />
            {!dup ? (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button disabled={busy || !template || !channels.length || !pv || preview.loading || blocked} onClick={() => send(false)} data-testid="composer-send">
                  <Send className="h-4 w-4" /> {busy ? "Sending…" : channels.length > 1 ? `Send (${channels.length} channels)` : `Send${channels[0] ? ` by ${CHANNEL_LABEL[channels[0]]}` : ""}`}
                </Button>
              </div>
            ) : null}
          </div>
        )
      }
    </DataState>
  );
}

/**
 * "Send message" on a record: the composer prefilled with it. Events inside the dialog don't reach the row or card
 * it sits in (a row click would otherwise expand or open the row). After something was sent, closing the dialog
 * calls `onSent` and reloads the list it sits in (if any) — not while it is open, so the row stays put meanwhile.
 */
export function SendMessageButton({ context, recordId, label = "Send message", size = "sm", variant = "outline", onSent, className }: {
  context: TemplateContext;
  recordId: string;
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  onSent?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const reloadList = useListReload();
  const close = (o: boolean) => {
    setOpen(o);
    if (!o && dirty) {
      setDirty(false);
      onSent?.();
      reloadList();
    }
  };
  return (
    <span className={cn("inline-flex", className)} onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={close}>
        <DialogTrigger asChild>
          <Button size={size} variant={variant} data-testid="send-message"><MessageSquareText className="h-4 w-4" /> {label}</Button>
        </DialogTrigger>
        {open ? (
          <DialogContent wide title="Send message" description="Pick a ready-made message, check it and send it.">
            <Composer context={context} recordId={recordId} onClose={() => close(false)} onSent={() => setDirty(true)} />
          </DialogContent>
        ) : null}
      </Dialog>
    </span>
  );
}
