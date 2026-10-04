"use client";
// v5 §3.1 Settings → Message Templates (Owner edits; the Manager reads them through the API and uses them in the
// composer). Every template: context, category, channels, WhatsApp / email / push text with {{variables}} (MT-1 checked
// on save), the optional Meta template for automatic WhatsApp, active. MT-2: preview the unsaved text with a real record.
// MT-3: each save of the text is a new version (listed below the editor); archive, never delete.
import { useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  CATEGORY_LABEL, CHANNEL_LABEL, CONTEXT_LABEL, FILL_IN_RE, MESSAGE_API, TEMPLATE_CATEGORIES, TEMPLATE_CHANNELS, TEMPLATE_CONTEXTS, WHATSAPP_MAX_CHARS,
  type LibraryResponse, type LibraryTemplate, type PreviewResponse, type RecordOption, type TemplateCategory, type TemplateChannel,
  type TemplateContext, type TemplateDetail, type TemplateInput, type VariablesResponse,
} from "@/server/services/messages/contract";

type Draft = Required<Omit<TemplateInput, "waTemplate">> & { waTemplate: string | null };
type TextField = "whatsappText" | "emailSubject" | "emailBody" | "pushTitle" | "pushBody";

const EMPTY: Draft = {
  name: "", context: "MEMBER", category: "TRANSACTIONAL", channels: ["WHATSAPP", "EMAIL"], whatsappText: "", emailSubject: "", emailBody: "",
  pushTitle: "", pushBody: "", waTemplate: null, active: true,
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const errOf = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });

function toDraft(t: LibraryTemplate): Draft {
  return {
    name: t.name, context: t.context, category: t.category, channels: t.channels, whatsappText: t.whatsappText, emailSubject: t.emailSubject,
    emailBody: t.emailBody, pushTitle: t.pushTitle, pushBody: t.pushBody, waTemplate: t.waTemplate, active: t.active,
  };
}

export function MessageTemplatesTab() {
  const lib = useApi<LibraryResponse>(`${MESSAGE_API.library}?archived=1`);
  const vars = useApi<VariablesResponse>(MESSAGE_API.variables);
  const [context, setContext] = useState<TemplateContext | "">("");
  const [category, setCategory] = useState<TemplateCategory | "">("");
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<LibraryTemplate | "new" | null>(null);
  return (
    <DataState state={lib}>
      {(d) => {
        const rows = d.templates.filter((t) => (!context || t.context === context) && (!category || t.category === category) && (archived ? !!t.archivedAt : !t.archivedAt));
        return (
          <Card data-testid="message-templates">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Message templates</CardTitle>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  Ready-made WhatsApp, email and push messages staff send from a member, booking, refund, order, tab, lead or invoice — and in bulk from
                  Members, Renewal &amp; Dues, Check-in Risk and the Leads Board. The front desk sends transactional templates; announcements are for the
                  Manager and you. Editing the text keeps the old version for the message log.
                </p>
              </div>
              {d.canManage ? <Button size="sm" onClick={() => setEditing("new")} data-testid="mt-new">New template</Button> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <Field label="Context" className="w-44">
                  <Select aria-label="Filter by context" value={context} onChange={(e) => setContext(e.target.value as TemplateContext | "")}>
                    <option value="">All contexts</option>
                    {TEMPLATE_CONTEXTS.map((c) => <option key={c} value={c}>{CONTEXT_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <Field label="Category" className="w-44">
                  <Select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory | "")}>
                    <option value="">All categories</option>
                    {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <label className="flex h-10 items-center gap-2">
                  <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived ({d.templates.filter((t) => t.archivedAt).length})
                </label>
              </div>
              {rows.length ? (
                <ul className="divide-y rounded-xl border">
                  {rows.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5" data-testid={`mt-row-${t.key ?? t.id}`}>
                      <div className="min-w-0">
                        <p className="font-medium">{t.name}</p>
                        <p className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                          <Badge tone="neutral">{CONTEXT_LABEL[t.context]}</Badge>
                          <Badge tone={t.category === "ANNOUNCEMENT" ? "purple" : "blue"}>{CATEGORY_LABEL[t.category]}</Badge>
                          {!t.active && !t.archivedAt ? <Badge tone="amber">Off</Badge> : null}
                          <span>{t.channels.map((c) => CHANNEL_LABEL[c]).join(" · ")}</span>
                          <span>· v{t.version}</span>
                          <span>· sent {t.sends} {t.sends === 1 ? "time" : "times"}</span>
                          {t.waTemplate ? <span>· automatic WhatsApp: {t.waTemplate}</span> : null}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setEditing(t)} aria-label={`${d.canManage ? "Edit" : "View"} ${t.name}`}>{d.canManage ? "Edit" : "View"}</Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No templates match these filters.</p>
              )}
              {editing ? (
                <Editor
                  key={editing === "new" ? "new" : editing.id}
                  template={editing === "new" ? null : editing}
                  canManage={d.canManage}
                  autoTemplates={d.autoWhatsAppTemplates}
                  variables={vars.data ?? null}
                  onClose={() => setEditing(null)}
                  onSaved={() => void lib.reload()}
                />
              ) : null}
            </CardContent>
          </Card>
        );
      }}
    </DataState>
  );
}

function Editor({ template, canManage, autoTemplates, variables, onClose, onSaved }: {
  template: LibraryTemplate | null;
  canManage: boolean;
  autoTemplates: LibraryResponse["autoWhatsAppTemplates"];
  variables: VariablesResponse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(template ? toDraft(template) : EMPTY);
  const [id, setId] = useState<string | null>(template?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const detail = useApi<TemplateDetail>(id ? MESSAGE_API.template(id) : null);
  const archivedAt = detail.data?.archivedAt ?? template?.archivedAt ?? null;
  const lastField = useRef<{ field: TextField; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSavedNote(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const has = (c: TemplateChannel) => draft.channels.includes(c);
  const readOnly = !canManage || !!archivedAt;
  const autoForContext = autoTemplates.filter((a) => a.context === draft.context);

  const insert = (name: string) => {
    const target = lastField.current;
    if (!target || readOnly) return;
    const token = `{{${name}}}`;
    const el = target.el;
    const value = draft[target.field];
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    set(target.field, `${value.slice(0, start)}${token}${value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  /** Remembers the text field the cursor was last in (where a clicked variable is inserted). */
  const rememberField = (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    lastField.current = { field: e.currentTarget.dataset.field as TextField, el: e.currentTarget };
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: TemplateInput = { ...draft, waTemplate: draft.waTemplate || null };
      const r = id
        ? await api<TemplateDetail>(MESSAGE_API.template(id), { method: "PATCH", body })
        : await api<TemplateDetail>(MESSAGE_API.templates, { body });
      setId(r.id);
      setDraft(toDraft(r));
      setSavedNote(`Saved — version ${r.version}.`);
      void detail.reload();
      onSaved();
    } catch (e) {
      setError(errOf(e));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (restore: boolean) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api(restore ? MESSAGE_API.restore(id) : MESSAGE_API.archive(id), { body: {} });
      void detail.reload();
      onSaved();
      if (!restore) onClose();
    } catch (e) {
      setError(errOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent wide title={template ? (readOnly ? template.name : `Edit: ${template.name}`) : "New message template"}
        description={archivedAt ? "Archived — restore it to edit or send it." : "Use the variables of the context; staff can still edit the text for one send."}>
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]" data-testid="mt-editor">
          <div className="flex flex-col gap-3 text-sm">
            <Field label="Name"><Input value={draft.name} onChange={(e) => set("name", e.target.value)} readOnly={readOnly} maxLength={80} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Context" hint="Where staff send it from — decides the variables.">
                <Select aria-label="Context" value={draft.context} disabled={readOnly} onChange={(e) => {
                  const c = e.target.value as TemplateContext;
                  setDraft((d) => ({ ...d, context: c, waTemplate: null, channels: c === "LEAD" ? d.channels.filter((x) => x !== "PUSH") : d.channels }));
                }}>
                  {TEMPLATE_CONTEXTS.map((c) => <option key={c} value={c}>{CONTEXT_LABEL[c]}</option>)}
                </Select>
              </Field>
              <Field label="Category" hint="Announcements: Manager and Owner only; they honour email unsubscribes.">
                <Select aria-label="Category" value={draft.category} disabled={readOnly} onChange={(e) => set("category", e.target.value as TemplateCategory)}>
                  {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </Select>
              </Field>
            </div>
            <fieldset className="flex flex-wrap items-center gap-4">
              <legend className="mb-1 text-sm font-semibold">Channels</legend>
              {TEMPLATE_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2">
                  <input type="checkbox" checked={has(c)} disabled={readOnly || (c === "PUSH" && draft.context === "LEAD")}
                    onChange={(e) => set("channels", e.target.checked ? [...draft.channels, c] : draft.channels.filter((x) => x !== c))} />
                  {CHANNEL_LABEL[c]}
                </label>
              ))}
              {draft.context === "LEAD" ? <span className="text-xs text-muted-foreground">Leads have no app, so no push.</span> : null}
            </fieldset>
            {has("WHATSAPP") ? (
              <Field label={`WhatsApp text (${draft.whatsappText.length} / ${WHATSAPP_MAX_CHARS})`} hint="*bold* for the key facts; keep it under 700 characters.">
                <Textarea rows={7} value={draft.whatsappText} onChange={(e) => set("whatsappText", e.target.value)} data-field="whatsappText" onFocus={rememberField} readOnly={readOnly}
                  className={draft.whatsappText.length > WHATSAPP_MAX_CHARS ? "border-destructive" : undefined} />
              </Field>
            ) : null}
            {has("EMAIL") ? (
              <>
                <Field label="Email subject"><Input value={draft.emailSubject} onChange={(e) => set("emailSubject", e.target.value)} data-field="emailSubject" onFocus={rememberField} readOnly={readOnly} maxLength={150} /></Field>
                <Field label="Email text" hint="Goes into the club's email layout (logo, button to the record's link, address and phone). Blank line = new paragraph.">
                  <Textarea rows={8} value={draft.emailBody} onChange={(e) => set("emailBody", e.target.value)} data-field="emailBody" onFocus={rememberField} readOnly={readOnly} />
                </Field>
              </>
            ) : null}
            {has("PUSH") ? (
              <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
                <Field label="Push title"><Input value={draft.pushTitle} onChange={(e) => set("pushTitle", e.target.value)} data-field="pushTitle" onFocus={rememberField} readOnly={readOnly} maxLength={80} /></Field>
                <Field label="Push text"><Input value={draft.pushBody} onChange={(e) => set("pushBody", e.target.value)} data-field="pushBody" onFocus={rememberField} readOnly={readOnly} maxLength={240} /></Field>
              </div>
            ) : null}
            {has("WHATSAPP") && autoForContext.length ? (
              <Field label="Send automatically on WhatsApp with" hint="Offered in the composer only when the WhatsApp API is on, this Meta template is approved and the person opted in.">
                <Select aria-label="Automatic WhatsApp template" value={draft.waTemplate ?? ""} disabled={readOnly} onChange={(e) => set("waTemplate", e.target.value || null)}>
                  <option value="">By hand only (wa.me link)</option>
                  {autoForContext.map((a) => <option key={a.name} value={a.name}>{a.label}</option>)}
                </Select>
              </Field>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.active} disabled={readOnly} onChange={(e) => set("active", e.target.checked)} /> Active (shown in the composer)
            </label>
            {[draft.whatsappText, draft.emailSubject, draft.emailBody, draft.pushTitle, draft.pushBody].some((t) => FILL_IN_RE.test(t)) ? (
              <p className="rounded-lg bg-warning/15 px-3 py-2 text-xs">Parts in [[ ]] must be written by staff before each send — sending is refused until they are.</p>
            ) : null}
            <RejectionBanner error={error} />
            <div className="flex flex-wrap items-center gap-2">
              {!readOnly ? <Button size="sm" disabled={busy} onClick={save} data-testid="mt-save">{busy ? "Saving…" : id ? "Save as a new version" : "Create template"}</Button> : null}
              {canManage && id && !archivedAt ? <Button size="sm" variant="outline" disabled={busy} onClick={() => archive(false)}>Archive</Button> : null}
              {canManage && id && archivedAt ? <Button size="sm" variant="outline" disabled={busy} onClick={() => archive(true)}>Restore</Button> : null}
              {savedNote ? <span className="text-xs text-success-text" role="status">{savedNote}</span> : null}
            </div>
          </div>
          <aside className="flex flex-col gap-3 text-sm">
            <div>
              <p className="font-semibold">Variables for {CONTEXT_LABEL[draft.context].toLowerCase()}</p>
              <p className="text-xs text-muted-foreground">{readOnly ? "Each is filled in from the record." : "Click to insert where the cursor is."}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="mt-variables">
                {(variables?.[draft.context] ?? []).map((v) => (
                  <li key={v.name}>
                    <button type="button" title={`${v.label} — ${v.example}`} onClick={() => insert(v.name)} disabled={readOnly}
                      className="rounded-full border bg-muted px-2 py-0.5 font-mono text-[11px] hover:bg-secondary disabled:cursor-default">{`{{${v.name}}}`}</button>
                  </li>
                ))}
              </ul>
            </div>
            <Preview draft={draft} />
            {detail.data?.versions.length ? (
              <details className="rounded-xl border px-3 py-2">
                <summary className="cursor-pointer font-semibold">Versions ({detail.data.versions.length})</summary>
                <ol className="mt-2 flex flex-col gap-2">
                  {detail.data.versions.map((v) => (
                    <li key={v.version} className="text-xs">
                      <p className="font-medium">v{v.version} · {when(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ""}</p>
                      <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{v.whatsappText || v.emailBody || v.pushBody}</p>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** MT-2: the unsaved text rendered with a real record of the template's context. */
function Preview({ draft }: { draft: Draft }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<RecordOption[]>([]);
  const [record, setRecord] = useState<RecordOption | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const ctx = draft.context;

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<RecordOption[]>(`${MESSAGE_API.records}?context=${ctx}&q=${encodeURIComponent(q)}`)
        .then((r) => live && setOptions(r))
        .catch(() => live && setOptions([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ctx, q]);

  const key = useMemo(() => JSON.stringify(draft), [draft]);
  useEffect(() => {
    if (!record) return;
    let live = true;
    const t = setTimeout(() => {
      api<PreviewResponse>(MESSAGE_API.preview, { body: { draft: { ...draft, waTemplate: draft.waTemplate || null }, recordId: record.id } })
        .then((r) => {
          if (!live) return;
          setResult(r);
          setError(null);
        })
        .catch((e) => {
          if (!live) return;
          setResult(null);
          setError(errOf(e));
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the draft's content
  }, [key, record]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border px-3 py-2" data-testid="mt-preview">
      <p className="font-semibold">Preview with a real {CONTEXT_LABEL[ctx].toLowerCase()}</p>
      <Input aria-label="Find a record to preview with" placeholder="Search by name or code" value={q} onChange={(e) => setQ(e.target.value)} />
      <Select aria-label="Record to preview with" value={record?.id ?? ""} onChange={(e) => {
        setRecord(options.find((o) => o.id === e.target.value) ?? null);
        setResult(null);
      }}>
        <option value="">{options.length ? "Choose a record…" : "No records found"}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.detail}</option>)}
      </Select>
      <RejectionBanner error={error} />
      {result ? (
        <div className="flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">To {result.recipient.name}{result.recipient.phone ? ` · ${result.recipient.phone}` : ""}{result.recipient.email ? ` · ${result.recipient.email}` : ""}</p>
          {result.rendered.whatsapp ? (
            <div>
              <p className="font-semibold">WhatsApp · {result.rendered.whatsapp.length} characters</p>
              <p className="whitespace-pre-wrap rounded-lg bg-success/10 px-2 py-1.5">{result.rendered.whatsapp.text}</p>
            </div>
          ) : null}
          {result.rendered.email ? (
            <div>
              <p className="font-semibold">Email · {result.rendered.email.subject}</p>
              <iframe title="Email preview" sandbox="" srcDoc={result.rendered.email.html} className="h-72 w-full rounded-lg border bg-white" />
            </div>
          ) : null}
          {result.rendered.push ? (
            <div>
              <p className="font-semibold">Push</p>
              <p className="rounded-lg border px-2 py-1.5"><span className="font-semibold">{result.rendered.push.title}</span><br />{result.rendered.push.body}</p>
            </div>
          ) : null}
        </div>
      ) : record ? null : (
        <p className="text-xs text-muted-foreground">Pick a record to see the message as it would be sent.</p>
      )}
    </div>
  );
}
