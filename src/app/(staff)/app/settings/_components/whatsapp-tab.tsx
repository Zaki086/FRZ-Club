"use client";
// v4 §5.1 Settings → WhatsApp (Owner): is the Cloud API connected (env set, token valid, webhook verified, test
// message sent), which WhatsApp Manager template each message uses, and Meta's status for each one. Without all of
// it, messages go to the desk's "Messages to send" queue instead.
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { loadCapabilities } from "@/components/capabilities";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { SaveBar } from "./shared";

type TemplateRow = { key: string; required: boolean; variables: number; button: string | null; name: string | null; language: string | null; status: string | null; checkedAt: string | null };
type Status = {
  capability: { enabled: boolean; reason: string };
  env: Array<{ name: string; set: boolean }>;
  envOk: boolean;
  token: { ok: boolean | null; checkedAt: string | null; reason: string | null; phone: string | null };
  webhook: { url: string | null; verifiedAt: string | null };
  testSentAt: string | null;
  buttonBase: string | null;
  templates: TemplateRow[];
};

const EVENT_LABEL: Record<string, string> = {
  club_session_cancelled: "Session cancelled by the club (reschedule or refund)",
  booking_cancelled_refund: "Booking cancelled + refund outcome",
  booking_rescheduled: "Reschedule confirmed",
  cancellation_choice_reminder: "Reminder to choose (cancelled session)",
  refund_ready_to_collect: "Refund ready to collect",
  refund_completed: "Refund collected",
  refund_rejected: "Refund not approved",
  refund_unclaimed_reminder: "Refund still waiting (reminder)",
  membership_welcome: "Welcome (optional)",
  membership_expiring: "Membership expiring (optional)",
  dues_reminder: "Dues reminder (optional)",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : null);

function statusTone(s: string | null): "green" | "amber" | "red" | "neutral" {
  if (s === "APPROVED") return "green";
  if (s === "PENDING" || s === "IN_APPEAL") return "amber";
  if (!s) return "neutral";
  return "red";
}

function Check({ label, ok, detail, testId }: { label: string; ok: boolean | null; detail: string | null; testId: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2" data-testid={testId}>
      <div>
        <p className="font-medium">{label}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <Badge tone={ok ? "green" : ok === false ? "red" : "neutral"}>{ok ? "Yes" : ok === false ? "No" : "Not checked"}</Badge>
    </div>
  );
}

function Mapping({ s, saved }: { s: Status; saved: () => void }) {
  const [rows, setRows] = useState<Record<string, { name: string; language: string }>>(
    Object.fromEntries(s.templates.map((t) => [t.key, { name: t.name ?? "", language: t.language ?? "en" }])),
  );
  const [meta, setMeta] = useState<Array<{ name: string; language: string; status: string; category: string }> | null>(null);
  return (
    <Card>
      <CardHeader><CardTitle>Message templates</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Create each template in WhatsApp Manager exactly as in <code>docs/whatsapp-templates.md</code> (category Utility, English), enter its name and
          language code here, then press “Fetch templates”. A message is sent automatically only when its template is mapped and APPROVED; otherwise it
          goes to “Messages to send”.{s.buttonBase ? ` Buttons open ${s.buttonBase}<suffix>.` : ""}
        </p>
        <Table data-testid="wa-templates">
          <THead>
            <TR><TH>Message</TH><TH>Template name</TH><TH>Language</TH><TH>Meta status</TH></TR>
          </THead>
          <TBody>
            {s.templates.map((t) => (
              <TR key={t.key} data-testid={`wa-template-${t.key}`}>
                <TD>
                  <p className="font-medium">{EVENT_LABEL[t.key] ?? t.key}</p>
                  <p className="text-xs text-muted-foreground">{t.key} · {t.variables} variables{t.button ? ` · button ${t.button}` : ""}</p>
                </TD>
                <TD>
                  <Input aria-label={`Template name for ${t.key}`} value={rows[t.key]?.name ?? ""} placeholder={t.key}
                    onChange={(e) => setRows({ ...rows, [t.key]: { ...rows[t.key], name: e.target.value.trim() } })} />
                </TD>
                <TD className="w-28">
                  <Input aria-label={`Language for ${t.key}`} value={rows[t.key]?.language ?? ""}
                    onChange={(e) => setRows({ ...rows, [t.key]: { ...rows[t.key], language: e.target.value.trim() } })} />
                </TD>
                <TD>
                  {t.name ? <Badge tone={statusTone(t.status)}>{t.status ?? "Not fetched"}</Badge> : <span className="text-xs text-muted-foreground">Not mapped</span>}
                  {t.checkedAt ? <p className="mt-1 text-xs text-muted-foreground">{when(t.checkedAt)}</p> : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <div className="flex flex-wrap gap-4">
          <SaveBar label="Save templates" onSave={async () => { await api("/api/whatsapp/templates", { method: "PUT", body: { templates: rows } }); saved(); }} />
          {s.env.find((e) => e.name === "WHATSAPP_BUSINESS_ACCOUNT_ID")?.set && s.env.find((e) => e.name === "WHATSAPP_ACCESS_TOKEN")?.set ? (
            <SaveBar label="Fetch templates" onSave={async () => {
              const r = await api<{ meta: Array<{ name: string; language: string; status: string; category: string }> }>("/api/whatsapp/templates/fetch", { method: "POST" });
              setMeta(r.meta);
              saved();
            }} />
          ) : null}
        </div>
        {meta ? (
          <div data-testid="wa-meta-templates">
            <p className="font-medium">Templates in WhatsApp Manager ({meta.length})</p>
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {meta.map((t) => (
                <li key={`${t.name}:${t.language}`} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1">
                  <span className="truncate">{t.name} <span className="text-xs text-muted-foreground">({t.language}{t.category ? ` · ${t.category.toLowerCase()}` : ""})</span></span>
                  <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function WhatsAppTab() {
  const status = useApi<Status>("/api/whatsapp/status");
  const [to, setTo] = useState("");
  const [tpl, setTpl] = useState("hello_world");
  const [lang, setLang] = useState("en_US");
  const saved = () => {
    void loadCapabilities(true);
    void status.reload();
  };
  return (
    <DataState state={status}>
      {(s) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <div className="flex items-start justify-between gap-3 pb-2" data-testid="wa-capability">
                <div>
                  <p className="font-medium">Automatic WhatsApp</p>
                  <p className="text-xs text-muted-foreground">{s.capability.reason}</p>
                </div>
                <Badge tone={s.capability.enabled ? "green" : "neutral"}>{s.capability.enabled ? "On" : "Off"}</Badge>
              </div>
              <div className="divide-y">
                <Check testId="wa-env" label="Keys in the server's .env" ok={s.envOk}
                  detail={s.envOk ? "All six WHATSAPP_* variables are set." : `Missing: ${s.env.filter((e) => !e.set).map((e) => e.name).join(", ")}`} />
                <Check testId="wa-token" label="Access token valid" ok={s.token.ok}
                  detail={[s.token.phone, s.token.reason, s.token.checkedAt ? `checked ${when(s.token.checkedAt)}` : null].filter(Boolean).join(" · ") || null} />
                <Check testId="wa-webhook" label="Webhook verified" ok={s.webhook.verifiedAt ? true : null}
                  detail={[s.webhook.url ? `Callback URL: ${s.webhook.url}` : "Set APP_URL to get the callback URL", s.webhook.verifiedAt ? `verified ${when(s.webhook.verifiedAt)}` : "Meta verifies it when you save the callback URL and verify token (WHATSAPP_WEBHOOK_VERIFY_TOKEN) in the app dashboard; subscribe to “messages”."].join(" · ")} />
                <Check testId="wa-test" label="Test message sent" ok={s.testSentAt ? true : null} detail={s.testSentAt ? `last success ${when(s.testSentAt)}` : null} />
              </div>
              {s.env.find((e) => e.name === "WHATSAPP_ACCESS_TOKEN")?.set ? (
                <SaveBar label="Check access token" onSave={async () => {
                  const r = await api<{ ok: boolean; reason?: string }>("/api/whatsapp/token-check", { method: "POST" });
                  saved();
                  if (!r.ok) throw new Error(`Meta rejected the token: ${r.reason ?? ""}`);
                }} />
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Send test message</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">
                Sends one template message. Meta&apos;s sample template <code>hello_world</code> (en_US) exists in every account and has no variables. When it
                arrives, automatic WhatsApp switches on (with a valid token). Meta charges per message.
              </p>
              <Field label="Mobile number"><Input inputMode="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Template"><Input value={tpl} onChange={(e) => setTpl(e.target.value.trim())} /></Field>
                <Field label="Language"><Input value={lang} onChange={(e) => setLang(e.target.value.trim())} /></Field>
              </div>
              <SaveBar label="Send test message" disabled={!s.envOk} onSave={async () => { await api("/api/whatsapp/test", { body: { to, template: tpl, language: lang } }); saved(); }} />
            </CardContent>
          </Card>
          <div className="lg:col-span-2">
            <Mapping s={s} saved={saved} />
          </div>
        </div>
      )}
    </DataState>
  );
}
