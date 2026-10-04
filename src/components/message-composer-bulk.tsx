"use client";
// v5 §3.4: bulk sending from a filtered list — the selected rows (or "all N matching the filter", max 500) → template →
// channels → the first 3 recipients rendered, who is skipped and why → confirm → progress (the worker sends email and
// push at ≤ 1 per second) → summary. Manual WhatsApp becomes one task per recipient, stepped through with "Send next".
import { useState } from "react";
import { MessageCircle, MessageSquareText, Pencil, Send } from "lucide-react";
import { api, ApiError, useApi } from "./api";
import { useListReload } from "./list/filtered-list";
import { DataState, Empty, Loading, RejectionBanner } from "./states";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTrigger } from "./ui/dialog";
import { cn } from "./ui/cn";
import { fmtDateTime } from "@/lib/time";
import {
  BULK_MAX,
  CHANNEL_LABEL,
  MESSAGE_API,
  MESSAGE_ERRORS,
  TEMPLATE_CHANNELS,
  type BulkList,
  type BulkPreviewResponse,
  type BulkProgress,
  type BulkResponse,
  type BulkSkip,
  type ComposerTemplate,
  type DuplicateDetails,
  type TemplateChannel,
  type TemplateDetail,
  type TemplateOverrides,
  type TemplatesResponse,
} from "@/server/services/messages/contract";
import { ChannelFields, ChannelPicker, RenderedView, TemplatePicker, toRejection, usePostPreview, type Rejection } from "./message-composer";
import {
  bulkChannelLines, bulkContext, bulkFinished, bulkPercent, channelsWithFillIn, defaultChannels, duplicateQuestion, fillInLeft, keepChannels, offerAutoWhatsApp,
  openPopup, overridesFor, renderedFields,
} from "./message-composer-logic";

/** Who a bulk send goes to: picked ids, or the list's filter ("all N matching"); `count` is what the screen shows. */
export type BulkTarget = { ids?: string[]; filter?: string; count: number };

function SkippedList({ skipped }: { skipped: BulkSkip[] }) {
  if (!skipped.length) return null;
  return (
    <details className="rounded-xl border p-2 text-sm" data-testid="bulk-skipped" open={skipped.length <= 5}>
      <summary className="cursor-pointer font-semibold">{skipped.length} skipped</summary>
      <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {skipped.map((s, i) => (
          <li key={`${s.name}-${s.channel ?? ""}-${i}`}>
            <span className="font-medium">{s.name}</span>
            {s.channel ? <span className="text-muted-foreground"> ({CHANNEL_LABEL[s.channel]} only)</span> : null}
            <span className="text-muted-foreground"> — {s.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Manual WhatsApp tasks of this bulk send: open the next one, send it from the club phone, mark it sent, repeat. */
function ManualStepper({ p, onChange }: { p: BulkProgress; onChange: () => void }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const left = p.manual.toSend + p.manual.opened;
  if (!p.manual.total) return null;
  const open = async (id: string) => {
    const w = openPopup();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>(MESSAGE_API.manualOpen(id), { body: {} });
      if (w) w.location.href = r.url;
      setCurrent(id);
      onChange();
    } catch (e) {
      w?.close();
      setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };
  const sent = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await api(MESSAGE_API.manualSent(current), { body: {} });
      setCurrent(null);
      onChange();
    } catch (e) {
      setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="bulk-manual">
      <p>
        <span className="font-semibold">WhatsApp by hand:</span> {p.manual.sent} of {p.manual.total} sent
        {left ? <> · <span data-testid="bulk-manual-left">{left}</span> to send (they also wait in Messages to Send)</> : null}
      </p>
      {current ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">WhatsApp opened — send it from the club phone, then</span>
          <Button size="sm" disabled={busy} onClick={sent} data-testid="bulk-mark-sent">Mark as sent</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => open(current)}>Open again</Button>
        </span>
      ) : p.manual.nextId ? (
        <Button size="sm" className="self-start" disabled={busy} onClick={() => open(p.manual.nextId!)} data-testid="bulk-send-next">
          <MessageCircle className="h-4 w-4" /> Send next
        </Button>
      ) : null}
      <RejectionBanner error={error} />
    </div>
  );
}

function Progress({ bulkId, onClose }: { bulkId: string; onClose: () => void }) {
  // Every 2 s while the worker sends; every 15 s while only WhatsApp-by-hand tasks are left; then stop.
  const [poll, setPoll] = useState<number | undefined>(2000);
  const state = useApi<BulkProgress>(MESSAGE_API.bulkStatus(bulkId), { pollMs: poll });
  const p = state.data;
  const want = !p ? 2000 : bulkFinished(p) ? undefined : p.status === "DONE" ? 15_000 : 2000;
  if (want !== poll) setPoll(want);
  return (
    <DataState state={state}>
      {(d) => {
        const pct = bulkPercent(d);
        const done = d.status === "DONE";
        return (
          <div className="flex flex-col gap-3" data-testid={done ? "bulk-summary" : "bulk-progress"}>
            <p className="text-sm">
              <span className="font-semibold">{d.template.name}</span> to {d.total} recipient{d.total === 1 ? "" : "s"} ·{" "}
              <Badge tone={done ? "green" : "amber"} data-testid="bulk-status">{done ? "Done" : d.status === "SENDING" ? "Sending" : "Queued"}</Badge>
            </p>
            {d.queued.total ? (
              <div className="flex flex-col gap-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label="Sending" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {d.queued.sent + d.queued.failed} of {d.queued.total} sent by the club{d.queued.failed ? ` (${d.queued.failed} failed)` : ""}
                  {!done && d.etaSeconds ? ` · about ${Math.ceil(d.etaSeconds / 60)} min left (1 message a second)` : ""}
                </p>
              </div>
            ) : null}
            <ul className="flex flex-col gap-0.5 text-sm" data-testid="bulk-channels">
              {bulkChannelLines(d).map((l) => <li key={l.channel}><span className="font-semibold">{l.label}:</span> {l.text}</li>)}
            </ul>
            <ManualStepper p={d} onChange={() => void state.reload()} />
            <SkippedList skipped={d.skipped} />
            <div className="flex justify-end">
              <Button variant={done ? "default" : "outline"} onClick={onClose} data-testid="bulk-close">{done ? "Done" : "Close (keeps sending)"}</Button>
            </div>
          </div>
        );
      }}
    </DataState>
  );
}

function BulkComposer({ list, target, onClose, onStarted, canEditText }: { list: BulkList; target: BulkTarget; onClose: () => void; onStarted?: () => void; canEditText: boolean }) {
  const lib = useApi<TemplatesResponse>(`${MESSAGE_API.templates}?context=${bulkContext(list)}`);
  const [picked, setPicked] = useState<string | null>(null);
  const [ticked, setTicked] = useState<TemplateChannel[] | null>(null);
  const [auto, setAuto] = useState(false);
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const [dup, setDup] = useState<DuplicateDetails | null>(null);
  const [started, setStarted] = useState<BulkResponse | null>(null);
  // "Edit the text for this send": the template's own text (with its {{variables}}, filled in per recipient).
  const [editOpen, setEditOpen] = useState(false);
  const [edits, setEdits] = useState<TemplateOverrides>({});

  const templates = lib.data?.templates ?? [];
  const template: ComposerTemplate | null = templates.find((t) => t.id === picked) ?? null;
  const channels = ticked ?? defaultChannels(template);
  const autoOn = auto && offerAutoWhatsApp(template, channels);
  // The template's own text is the library's (Manager and Owner read it); without it there is nothing to edit from.
  const source = useApi<TemplateDetail>(template && editOpen && canEditText ? MESSAGE_API.template(template.id) : null);
  const base: TemplateOverrides = source.data
    ? { whatsappText: source.data.whatsappText, emailSubject: source.data.emailSubject, emailBody: source.data.emailBody, pushTitle: source.data.pushTitle, pushBody: source.data.pushBody }
    : {};
  const overrides = source.data ? overridesFor(channels, edits, base) : undefined;
  const who = target.filter !== undefined ? { filter: target.filter } : { ids: target.ids ?? [] };
  const body = template && channels.length ? { templateId: template.id, list, ...who, channels, overrides, autoWhatsApp: autoOn || undefined } : null;
  const preview = usePostPreview<BulkPreviewResponse>(MESSAGE_API.bulkPreview, started ? null : body);
  const pv = preview.data;
  // A [[fill-in]] part in the text (e.g. a club notice) opens the edit boxes by itself; nothing goes out until it's written.
  const sampleFillIn = !!pv && pv.sample.some((x) => channelsWithFillIn(x.channels, renderedFields(x.rendered, null)).length > 0);
  if (sampleFillIn && !editOpen && !started) setEditOpen(true);
  const blocked = editOpen && (!source.data || fillInLeft(channels, edits, base));
  const noEdit = !canEditText && (sampleFillIn || editOpen);

  if (started) return <Progress bulkId={started.bulkId} onClose={onClose} />;

  const confirm = async (confirmDuplicate: boolean) => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<BulkResponse>(MESSAGE_API.bulk, { body: { ...body, confirmDuplicate: confirmDuplicate || undefined } });
      setStarted(r);
      onStarted?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === MESSAGE_ERRORS.DUPLICATE_RECENT_SEND) setDup((e.details ?? {}) as DuplicateDetails);
      else setError(toRejection(e));
    } finally {
      setBusy(false);
    }
  };

  const dupCount = pv?.duplicates.length ?? 0;
  return (
    <DataState state={lib}>
      {(d) =>
        d.templates.length === 0 ? (
          <Empty title="No message templates for this list" hint="The Owner adds templates in Settings → Message Templates." />
        ) : (
          <div className="flex flex-col gap-4" data-testid="bulk-composer">
            <p className="text-sm">
              To <span className="font-semibold" data-testid="bulk-count">{target.count.toLocaleString("en-IN")}</span>{" "}
              {target.filter !== undefined ? "matching the filter" : "selected"} (max {BULK_MAX})
            </p>
            <TemplatePicker
              templates={d.templates}
              value={template?.id ?? null}
              onChange={(t) => { setPicked(t.id); setTicked(keepChannels(t, channels)); setAuto(false); setAgain(false); setDup(null); setEditOpen(false); setEdits({}); }}
            />
            {template ? <ChannelPicker template={template} value={channels} onChange={(c) => setTicked(c)} auto={auto} onAuto={setAuto} /> : null}
            {body ? (
              <section className="flex flex-col gap-2" aria-label="Preview" data-testid="bulk-preview">
                <p className="text-sm font-semibold">3. Preview — the first 3 recipients</p>
                <RejectionBanner error={preview.error} />
                <div className="flex flex-col gap-2 rounded-xl border p-3" data-testid="bulk-edit">
                  {noEdit ? (
                    <p className="text-sm text-warning-text">This message has a part to write first ([[…]]); only a Manager or the Owner can send it in bulk.</p>
                  ) : !canEditText ? (
                    <p className="text-xs text-muted-foreground">The template&apos;s text goes out as it is (a Manager or the Owner can edit it for a send).</p>
                  ) : !editOpen ? (
                    <Button size="sm" variant="ghost" className="self-start" onClick={() => setEditOpen(true)}><Pencil className="h-3.5 w-3.5" /> Edit the text for this send</Button>
                  ) : source.error ? (
                    <RejectionBanner error={source.error} />
                  ) : !source.data ? (
                    <Loading label="Loading the template…" />
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">The same text for everyone — {"{{variables}}"} are filled in for each recipient. The template itself stays as it is.</p>
                      {TEMPLATE_CHANNELS.filter((c) => channels.includes(c)).map((c) => (
                        <div key={c} className="flex flex-col gap-1">
                          <p className="text-xs font-semibold">{CHANNEL_LABEL[c]}</p>
                          <ChannelFields channel={c} edits={edits} base={base} onEdits={setEdits} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
                {!pv ? <Loading label="Finding recipients…" /> : (
                  <>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span><span className="font-semibold" data-testid="bulk-total">{pv.total}</span> will get it</span>
                      {TEMPLATE_CHANNELS.filter((c) => channels.includes(c)).map((c) => <Badge key={c} tone="blue">{CHANNEL_LABEL[c]} {pv.perChannel[c] ?? 0}</Badge>)}
                    </p>
                    {pv.sample.map((s) => (
                      <div key={s.recipient.id} className="flex flex-col gap-1 rounded-xl border p-3" data-testid="bulk-sample">
                        <p className="text-sm font-semibold">{s.recipient.name} <span className="text-xs font-normal text-muted-foreground">{s.channels.map((c) => CHANNEL_LABEL[c]).join(" · ")}</span></p>
                        <RenderedView rendered={s.rendered} channels={s.channels} />
                      </div>
                    ))}
                    <SkippedList skipped={pv.skipped} />
                    {dupCount ? (
                      <label className="flex items-start gap-2 rounded-xl border border-warning/60 bg-warning/15 p-3 text-sm">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={again} onChange={(e) => setAgain(e.target.checked)} data-testid="bulk-confirm-duplicates" />
                        <span>{duplicateQuestion({ recipients: pv.duplicates, lastSentAt: pv.duplicates[0].lastSentAt, sentBy: null }, "", fmtDateTime)} Tick to include them.</span>
                      </label>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
            {dup ? (
              <div role="alertdialog" aria-label="Sent recently" className="flex flex-col gap-2 rounded-xl border border-warning/60 bg-warning/15 p-3 text-sm" data-testid="duplicate-guard">
                <p>{duplicateQuestion(dup, "Someone on the list", fmtDateTime)}</p>
                <span className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDup(null)}>Don&apos;t send</Button>
                  <Button size="sm" disabled={busy} onClick={() => confirm(true)} data-testid="duplicate-confirm">Send again</Button>
                </span>
              </div>
            ) : null}
            <RejectionBanner error={error} />
            {!dup ? (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  disabled={busy || !pv || preview.loading || !pv.total || blocked || (dupCount > 0 && !again)}
                  onClick={() => confirm(dupCount > 0 && again)}
                  data-testid="bulk-confirm"
                >
                  <Send className="h-4 w-4" /> {busy ? "Starting…" : `Send to ${pv?.total ?? "…"}`}
                </Button>
              </div>
            ) : null}
          </div>
        )
      }
    </DataState>
  );
}

/** "Send message" for a list selection (bulk). Closing the dialog after a send started calls `onDone` and reloads the list. */
export function BulkSendButton({ list, target, onDone, label = "Send message", className, canEditText = false }: {
  list: BulkList;
  target: BulkTarget;
  onDone?: () => void;
  label?: string;
  className?: string;
  /** May edit the text for this send (reads the template library: Manager and Owner). */
  canEditText?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const reloadList = useListReload();
  const close = (o: boolean) => {
    setOpen(o);
    if (!o && started) {
      setStarted(false);
      onDone?.();
      reloadList();
    }
  };
  return (
    <span className={cn("inline-flex", className)} onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={close}>
        <DialogTrigger asChild>
          <Button size="sm" disabled={!target.count} data-testid="bulk-send-message"><MessageSquareText className="h-4 w-4" /> {label}</Button>
        </DialogTrigger>
        {open ? (
          <DialogContent wide title={`Send message to ${target.count.toLocaleString("en-IN")}`} description="One ready-made message to everyone selected, on the channels each person can receive.">
            <BulkComposer list={list} target={target} onClose={() => close(false)} onStarted={() => setStarted(true)} canEditText={canEditText} />
          </DialogContent>
        ) : null}
      </Dialog>
    </span>
  );
}
